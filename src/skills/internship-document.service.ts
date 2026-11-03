import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { User } from '../entities/user.entity';
import { SkillTutorial } from '../entities/skill-tutorial.entity';
import { updateLockedRow } from '../database/locked-row.util';
import { PaymentsService } from '../payments/payments.service';
import { WorkshopService } from './workshop.service';
import { InternshipDocumentPdfService } from './internship-document-pdf.service';

const DEFAULT_PRICE_USD = 5;
const DEFAULT_CUSTOMIZE_EMAIL = 'alphatech2050@gmail.com';

/**
 * The internship document: once a learner has passed every level and project
 * they can APPLY for it, which means paying a flat fee through Paystack. After
 * the payment is confirmed the document is generated automatically from their
 * real progress and can be downloaded as a PDF at any time.
 *
 * Customized versions are handled by email: the learner writes to
 * INTERNSHIP_CUSTOMIZE_EMAIL (default alphatech2050@gmail.com).
 */
@Injectable()
export class InternshipDocumentService {
  constructor(
    @InjectRepository(SkillTutorial) private tutorials: Repository<SkillTutorial>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectDataSource() private dataSource: DataSource,
    private config: ConfigService,
    private payments: PaymentsService,
    private workshop: WorkshopService,
    private pdf: InternshipDocumentPdfService,
  ) {}

  private priceUsd(): number {
    const v = Number(this.config.get<string>('INTERNSHIP_DOCUMENT_PRICE_USD'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : DEFAULT_PRICE_USD;
  }

  private customizeEmail(): string {
    return this.config.get<string>('INTERNSHIP_CUSTOMIZE_EMAIL')?.trim() || DEFAULT_CUSTOMIZE_EMAIL;
  }

  private appName(): string {
    return this.config.get<string>('APP_NAME')?.trim() || 'Sherpar';
  }

  /** Where the learner stands: can they apply, have they paid, what is the document number. */
  async status(userId: string, id: string) {
    const snap = await this.workshop.completionSnapshot(userId, id);
    let paid = await this.payments.findPaidInternshipDocument(userId, id);
    if (!paid && snap.finished) {
      // The buyer may have closed the tab before Paystack redirected back - settle a pending payment ourselves.
      await this.payments.settlePendingInternshipDocument(userId, id);
      paid = await this.payments.findPaidInternshipDocument(userId, id);
    }

    const doc = snap.record.internshipDocument ?? null;
    return {
      eligible: snap.finished,
      progressPercent: snap.summary?.progress.percent ?? 0,
      paid: !!paid && snap.finished,
      priceUsd: this.priceUsd(),
      documentNumber: doc?.number ?? null,
      issuedAt: doc?.issuedAt ?? null,
      customizeEmail: this.customizeEmail(),
      message: !snap.finished
        ? 'Complete every level and project in the internship to apply for your document.'
        : paid
          ? 'Your internship document is ready to download.'
          : 'You have completed the internship. Pay the document fee to receive your internship document.',
    };
  }

  /** Starts the payment (Paystack checkout). Nothing is charged until the learner pays on Paystack. */
  async apply(userId: string, id: string, currency?: string) {
    const snap = await this.workshop.completionSnapshot(userId, id);
    if (!snap.finished) throw new ForbiddenException('Finish every level and project in the internship before you apply for the document.');

    const already = await this.payments.findPaidInternshipDocument(userId, id);
    if (already) return { alreadyPaid: true as const };

    const init = await this.payments.initializeInternshipDocument(userId, id, this.priceUsd(), currency);
    return { alreadyPaid: false as const, ...init };
  }

  /** Builds the PDF. Only after the internship is finished AND the fee is paid. */
  async download(userId: string, id: string): Promise<{ buffer: Buffer; filename: string }> {
    const snap = await this.workshop.completionSnapshot(userId, id);
    if (!snap.finished || !snap.plan || !snap.summary) {
      throw new ForbiddenException('Finish every level and project in the internship first.');
    }
    const paid = await this.payments.findPaidInternshipDocument(userId, id);
    if (!paid) throw new ForbiddenException('Pay the document fee to download your internship document.');

    const { record, plan, attempts, summary } = snap;

    // Issue the number once; concurrent first downloads cannot produce two different numbers.
    let issued = record.internshipDocument;
    if (!issued) {
      const fresh = {
        number: `INT-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`,
        issuedAt: new Date(),
        reference: paid.reference,
      };
      // Write only if still empty (row-locked), so the first writer's number is the one that sticks.
      await updateLockedRow<{ internshipDocument: unknown }>(
        this.dataSource,
        SkillTutorial,
        { id: record.id, userId },
        ['internshipDocument'],
        (row) => (row.internshipDocument ? null : { internshipDocument: fresh }),
      );
      const reread = await this.tutorials.findOne({
        where: { id: record.id, userId },
        select: { id: true, internshipDocument: true },
      });
      issued = reread?.internshipDocument ?? fresh;
    }
    if (!issued) throw new NotFoundException('Could not issue the document.');

    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const learnerName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || (user?.email ?? 'Intern').split('@')[0];

    const passed = attempts.filter((a) => a.passed);
    const stamps = attempts.map((a) => new Date(a.attemptedAt).getTime());
    const passStamps = passed.map((a) => new Date(a.attemptedAt).getTime());
    const bestByStep = new Map<string, number>();
    for (const a of passed) bestByStep.set(`${a.unitId}:${a.stepIndex}`, Math.max(bestByStep.get(`${a.unitId}:${a.stepIndex}`) ?? 0, a.score));
    const scores = [...bestByStep.values()];

    const buffer = await this.pdf.render({
      appName: this.appName(),
      documentNumber: issued.number,
      issuedAt: new Date(issued.issuedAt),
      learnerName,
      learnerEmail: user?.email ?? '',
      courseTitle: record.title,
      programTitle: plan.title,
      startedAt: stamps.length ? new Date(Math.min(...stamps)) : null,
      completedAt: passStamps.length ? new Date(Math.max(...passStamps)) : null,
      totals: {
        levels: summary.progress.totalLevels,
        projects: summary.progress.totalProjects,
        steps: summary.progress.passedSteps,
        attempts: summary.progress.attempts,
        xp: summary.progress.xp,
        averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      },
      levels: plan.units.filter((u) => u.kind === 'level').map((u) => ({ title: u.title, tier: u.tier, steps: u.steps?.length ?? u.outline.length })),
      projects: plan.units
        .filter((u) => u.kind === 'project')
        .map((u) => ({ title: u.title, role: u.role, deliverables: u.deliverables ?? [], techStack: u.techStack ?? [] })),
      customizeEmail: this.customizeEmail(),
    });

    const slug = record.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 50) || 'course';
    return { buffer, filename: `internship-document-${slug}.pdf` };
  }
}
