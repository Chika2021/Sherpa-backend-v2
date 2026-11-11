import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { readFile, stat, unlink } from 'fs/promises';
import { resolve, sep } from 'path';
import { Repository } from 'typeorm';
import { GeminiService, ResumeProfile } from '../../ai/gemini.service';
import { RateLimiter } from '../../common/rate-limiter';
import { assertValidId } from '../../database/db-utils';
import { Application } from '../../entities/application.entity';
import { EmailApplication } from '../../entities/email-application.entity';
import { GeneratedDocument } from '../../entities/generated-document.entity';
import { Job } from '../../entities/job.entity';
import { User } from '../../entities/user.entity';
import { MailService } from '../../mail/mail.service';
import { ResumesService } from '../../resumes/resumes.service';
import { TokensService } from '../../tokens/tokens.service';
import { ApplicationsService } from '../applications.service';
import {
  CreateEmailApplicationDto,
  RegenerateEmailDto,
  SendEmailApplicationDto,
  UpdateEmailApplicationDto,
} from './dto/email-apply.dto';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // keeps us under the strictest provider limit
const STALE_SENDING_MS = 5 * 60_000; // a send that never reported back (crash/restart) can be retried after this
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

// Applying by email sends real mail from the app's domain, so it is rate-limited per user (in memory, per instance).
const sendsPerHour = new RateLimiter(10, 60 * 60_000);
const sendsPerDay = new RateLimiter(30, 24 * 60 * 60_000);

/**
 * Apply by email. The user types the job (title, description, requirements); the app creates a private "manual"
 * job + Application, generates a tailored resume and cover letter (the same documents every other apply flow
 * makes) and drafts the cover email. The user reviews/edits it, then presses Send: the email goes out with both
 * documents attached and the application is registered as SUBMITTED.
 *
 * Nothing is ever sent without an explicit call to `send`.
 */
@Injectable()
export class EmailApplyService {
  private readonly logger = new Logger(EmailApplyService.name);

  constructor(
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(EmailApplication) private emails: Repository<EmailApplication>,
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(GeneratedDocument) private documents: Repository<GeneratedDocument>,
    @InjectRepository(User) private users: Repository<User>,
    private gemini: GeminiService,
    private resumesService: ResumesService,
    private applicationsService: ApplicationsService,
    private mail: MailService,
    private tokens: TokensService,
    private config: ConfigService,
  ) {}

  // ------------------------------------------------------------------ create

  /** Creates the application, generates the resume + cover letter, and drafts the email. Costs 3 AI generations. */
  async createDraft(userId: string, dto: CreateEmailApplicationDto) {
    const resume = dto.resumeId
      ? await this.resumesService.findOne(userId, dto.resumeId)
      : await this.resumesService.getPrimary(userId);
    await this.assertCanAffordDraft(userId);

    const company = dto.company?.trim() || undefined;
    const description = dto.requirements?.trim()
      ? `${dto.jobDescription.trim()}\n\nRequirements:\n${dto.requirements.trim()}`
      : dto.jobDescription.trim();

    // A private job row for this user only (shared job rows would let one user's edits leak into another's).
    const job = await this.jobs.save(
      this.jobs.create({
        source: 'manual',
        applyUrl: `manual://${randomUUID()}`,
        title: dto.jobTitle.trim(),
        company,
        jobType: 'CUSTOM',
        description,
      }),
    );
    const application = await this.applications.save(
      this.applications.create({ userId, jobId: job.id, resumeId: resume.id, status: 'PENDING' }),
    );

    // Throws (and marks the application FAILED) if the documents can't be generated; the user can retry
    // with POST :id/regenerate-documents.
    await this.applicationsService.generateDocuments(userId, application.id);

    const warnings: string[] = [];
    const { profile } = await this.contextFor(userId, resume.parsedProfile as ResumeProfile | null);
    const draft = await this.draftEmail(
      userId,
      profile,
      { title: job.title, company: job.company || 'the company', description },
      { recipientName: dto.recipientName },
      warnings,
    );

    await this.emails.save(
      this.emails.create({
        userId,
        applicationId: application.id,
        recipientEmail: dto.recipientEmail?.trim().toLowerCase() || null,
        recipientName: dto.recipientName?.trim() || null,
        subject: draft.subject,
        body: draft.body,
        status: 'DRAFT',
      }),
    );
    return { ...(await this.view(userId, application.id)), warnings };
  }

  // -------------------------------------------------------------------- read

  /** The application (job + documents + email draft), plus whether this server can actually deliver mail. */
  async view(userId: string, applicationId: string) {
    const application = await this.applicationsService.getOwnedForResponse(userId, applicationId);
    if (!application.emailApplication) throw new NotFoundException('This application was not made by email.');
    return { ...application, mailConfigured: this.mail.canDeliver() };
  }

  // -------------------------------------------------------------------- edit

  async update(userId: string, applicationId: string, dto: UpdateEmailApplicationDto) {
    const email = await this.getEditable(userId, applicationId);
    await this.emails.update({ id: email.id }, this.editPatch(dto));
    return this.view(userId, applicationId);
  }

  /** Rewrites only the email (1 AI generation). */
  async regenerateEmail(userId: string, applicationId: string, dto: RegenerateEmailDto) {
    const email = await this.getEditable(userId, applicationId);
    const app = await this.applicationsService.getOwned(userId, applicationId);
    if (!app.job) throw new NotFoundException('Job not found');
    const resume = await this.resumesService.findOne(userId, String(app.resumeId));
    const { profile } = await this.contextFor(userId, resume.parsedProfile as ResumeProfile | null);

    const recipientName = dto.recipientName?.trim() || email.recipientName || undefined;
    // Unlike the first draft, a failure here is reported: silently swapping in a template would ignore what the user asked for.
    const draft = await this.gemini.generateApplicationEmail(
      userId,
      profile,
      { title: app.job.title, company: app.job.company || 'the company', description: app.job.description },
      { recipientName, instructions: dto.instructions },
    );
    await this.emails.update(
      { id: email.id },
      { subject: draft.subject, body: draft.body, ...(dto.recipientName !== undefined ? { recipientName: recipientName || null } : {}) },
    );
    return this.view(userId, applicationId);
  }

  /** Regenerates the resume + cover letter (2 AI generations) and removes the previous versions once the new ones exist. */
  async regenerateDocuments(userId: string, applicationId: string) {
    await this.getEditable(userId, applicationId);
    const before = await this.documents.find({ where: { applicationId } });
    await this.applicationsService.generateDocuments(userId, applicationId);
    const old = before.filter((d) => !!d.id);
    if (old.length) {
      await this.documents.delete(old.map((d) => d.id));
      await Promise.all(old.map((d) => this.deleteGeneratedFile(d.filePath)));
    }
    return this.view(userId, applicationId);
  }

  // -------------------------------------------------------------------- send

  /** Sends the email with the latest resume + cover letter attached, then registers the application as applied. */
  async send(userId: string, applicationId: string, dto: SendEmailApplicationDto) {
    if (!this.mail.canDeliver()) {
      throw new ServiceUnavailableException(
        'Sending email is not set up on this server yet. Your draft is saved: copy it and the documents into your own email app.',
      );
    }
    const existing = await this.getOwnedEmail(userId, applicationId);
    if (existing.status === 'SENT' && !dto.resend) {
      throw new ConflictException('This application has already been emailed. Send again only if you really mean to (resend: true).');
    }

    // Apply any edits that came with the request, then validate the final message.
    const patch = this.editPatch(dto);
    const recipient = String(patch.recipientEmail ?? existing.recipientEmail ?? '').trim().toLowerCase();
    const subject = String(patch.subject ?? existing.subject ?? '').replace(/\s+/g, ' ').trim();
    const body = String(patch.body ?? existing.body ?? '').trim();
    if (!recipient || !EMAIL_RE.test(recipient)) throw new BadRequestException('Add the email address to send the application to.');
    if (!subject) throw new BadRequestException('The email needs a subject.');
    if (body.length < 20) throw new BadRequestException('The email body is too short to send.');

    const { application, resumeDoc, coverLetterDoc } = await this.loadSendable(userId, applicationId);
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const resume = await this.resumesService.findOne(userId, String(application.resumeId));
    const { profile, applicantName } = await this.contextFor(userId, resume.parsedProfile as ResumeProfile | null, user);
    const attachments = await this.readAttachments(applicantName, resumeDoc, coverLetterDoc);

    // Past every check that can fail for the user's own reasons: take the send slot (blocks double-clicks / parallel sends).
    sendsPerHour.check(`email-apply:${userId}`);
    sendsPerDay.check(`email-apply-day:${userId}`);
    const allowed = dto.resend ? ['DRAFT', 'FAILED', 'SENT'] : ['DRAFT', 'FAILED'];
    const claim = await this.emails
      .createQueryBuilder()
      .update(EmailApplication)
      .set({ ...patch, recipientEmail: recipient, subject, body, status: 'SENDING', sendError: null })
      .where('id = :id AND "userId" = :userId', { id: existing.id, userId })
      .andWhere(`(status IN (:...allowed) OR (status = 'SENDING' AND "updatedAt" < :stale))`, {
        allowed,
        stale: new Date(Date.now() - STALE_SENDING_MS),
      })
      .execute();
    if (!claim.affected) throw new ConflictException('This application is being sent right now.');

    const replyTo = profile.email && EMAIL_RE.test(profile.email) ? profile.email.toLowerCase() : user.email;
    try {
      await this.mail.sendApplicationEmail({
        to: recipient,
        subject,
        text: body,
        applicantName,
        replyTo,
        bcc: dto.sendCopyToMe === false ? undefined : user.email,
        attachments,
      });
    } catch (err) {
      this.logger.error(`Application email ${applicationId} to ${recipient} failed: ${(err as Error).message}`);
      await this.emails.update(
        { id: existing.id },
        { status: 'FAILED', sendError: "The email provider couldn't deliver it. Check the address and try again in a moment." },
      );
      throw new ServiceUnavailableException(
        "We couldn't send the email. Nothing was sent: check the recipient address and try again in a moment.",
      );
    }

    const sentAt = new Date();
    await this.emails.update({ id: existing.id }, { status: 'SENT', sentAt, sendError: null });
    await this.applications.update(
      { id: applicationId },
      {
        status: 'SUBMITTED',
        submittedAt: sentAt,
        feedback: `Applied by email to ${recipient} with your tailored resume and cover letter attached.\nReplies go to ${replyTo}.`,
      },
    );
    return this.view(userId, applicationId);
  }

  // ----------------------------------------------------------------- helpers

  private async assertCanAffordDraft(userId: string) {
    const need = ['generateTailoredResume', 'generateCoverLetter', 'generateApplicationEmail'].reduce(
      (sum, label) => sum + this.tokens.costForFeature(label),
      0,
    );
    const balance = await this.tokens.getBalance(userId);
    if (balance < need) {
      throw new BadRequestException(
        `Not enough tokens. An email application (resume + cover letter + email) needs ${need} token${need === 1 ? '' : 's'} and you have ${balance}. Top up to continue.`,
      );
    }
  }

  private async getOwnedEmail(userId: string, applicationId: string): Promise<EmailApplication> {
    assertValidId(applicationId, 'Application');
    assertValidId(userId, 'User');
    const email = await this.emails.findOne({ where: { applicationId, userId } });
    if (!email) throw new NotFoundException('Email application not found');
    return email;
  }

  /** The email row, only while it can still be changed (not mid-send, not already sent). */
  private async getEditable(userId: string, applicationId: string): Promise<EmailApplication> {
    const email = await this.getOwnedEmail(userId, applicationId);
    if (email.status === 'SENDING') throw new ConflictException('This application is being sent right now.');
    if (email.status === 'SENT') throw new ConflictException('This application was already sent, so it can no longer be edited.');
    return email;
  }

  /** Normalised column values for the edit fields that were actually provided. */
  private editPatch(dto: UpdateEmailApplicationDto): Partial<EmailApplication> {
    const patch: Partial<EmailApplication> = {};
    if (dto.recipientEmail !== undefined) patch.recipientEmail = dto.recipientEmail.trim().toLowerCase();
    if (dto.recipientName !== undefined) patch.recipientName = dto.recipientName.trim() || null;
    if (dto.subject !== undefined) patch.subject = dto.subject.replace(/\s+/g, ' ').trim();
    if (dto.body !== undefined) patch.body = dto.body.replace(/\r\n/g, '\n').trim();
    return patch;
  }

  /** The profile the AI writes from: the resume's parsed profile, filled in from the account where it is missing. */
  private async contextFor(userId: string, parsed: ResumeProfile | null, knownUser?: User) {
    const user = knownUser ?? (await this.users.findOneBy({ id: userId }));
    const base = (parsed || { skills: [], experience: [], education: [] }) as ResumeProfile;
    const accountName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
    const profile: ResumeProfile = {
      ...base,
      fullName: base.fullName || accountName || undefined,
      email: base.email || user?.email,
      phone: base.phone || user?.phone,
      location: base.location || user?.location,
    };
    return { profile, applicantName: profile.fullName || 'Applicant' };
  }

  /** The AI email, or (if the model is unavailable) a plain template, so the user still gets something to edit. */
  private async draftEmail(
    userId: string,
    profile: ResumeProfile,
    job: { title: string; company: string; description: string },
    opts: { recipientName?: string },
    warnings: string[],
  ): Promise<{ subject: string; body: string }> {
    try {
      return await this.gemini.generateApplicationEmail(userId, profile, job, opts);
    } catch (err) {
      this.logger.warn(`AI email draft failed, using the template: ${(err as Error).message}`);
      warnings.push('The AI could not write the email this time, so a simple template was used. Edit it, or use "regenerate email" to try again.');
      const name = profile.fullName || 'Applicant';
      const at = job.company && job.company !== 'the company' ? ` at ${job.company}` : '';
      const greeting = opts.recipientName?.trim()
        ? `Dear ${opts.recipientName.trim()},`
        : at
          ? `Dear ${job.company} Hiring Team,`
          : 'Dear Hiring Team,';
      const contact = [profile.phone, profile.email].filter(Boolean).join('\n');
      return {
        subject: `Application for ${job.title} - ${name}`.slice(0, 150),
        body: [
          greeting,
          `I would like to apply for the ${job.title} position${at}. ${profile.headline ? `${profile.headline.replace(/\.$/, '')}. ` : ''}I have attached my resume and a cover letter tailored to the role.`,
          'I would welcome the chance to discuss how I can contribute to your team. Thank you for your time and consideration.',
          `Kind regards,\n${name}${contact ? `\n${contact}` : ''}`,
        ].join('\n\n'),
      };
    }
  }

  /** The application plus the LATEST resume and cover letter (regeneration leaves older versions in the list). */
  private async loadSendable(userId: string, applicationId: string) {
    const application = await this.applicationsService.getOwned(userId, applicationId);
    const docs = await this.documents.find({ where: { applicationId }, order: { createdAt: 'DESC' } });
    const resumeDoc = docs.find((d) => d.type === 'RESUME');
    const coverLetterDoc = docs.find((d) => d.type === 'COVER_LETTER');
    if (!resumeDoc || !coverLetterDoc) {
      throw new BadRequestException('The resume and cover letter have not been generated yet. Use "regenerate documents" first.');
    }
    return { application, resumeDoc, coverLetterDoc };
  }

  private async readAttachments(applicantName: string, resumeDoc: GeneratedDocument, coverLetterDoc: GeneratedDocument) {
    const safe = applicantName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Applicant';
    const files = [
      { filename: `${safe}_Resume.docx`, path: resumeDoc.filePath },
      { filename: `${safe}_Cover_Letter.docx`, path: coverLetterDoc.filePath },
    ];
    const root = resolve(this.config.get<string>('GENERATED_DIR') || './generated');
    const out: Array<{ filename: string; content: Buffer; mimeType: string }> = [];
    let total = 0;
    for (const f of files) {
      const full = resolve(f.path);
      if (!full.startsWith(root + sep)) throw new BadRequestException('A generated document is missing. Regenerate the documents and try again.');
      try {
        total += (await stat(full)).size;
        if (total > MAX_ATTACHMENT_BYTES) throw new BadRequestException('The documents are too large to email (over 4 MB).');
        out.push({ filename: f.filename, content: await readFile(full), mimeType: DOCX_MIME });
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException('A generated document file is missing. Regenerate the documents and try again.');
      }
    }
    return out;
  }

  /** Best effort, and only ever inside the generated folder. */
  private async deleteGeneratedFile(filePath: string) {
    const root = resolve(this.config.get<string>('GENERATED_DIR') || './generated');
    const full = resolve(filePath);
    if (!full.startsWith(root + sep)) return;
    await unlink(full).catch(() => undefined);
  }
}
