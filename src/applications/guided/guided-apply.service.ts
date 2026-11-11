import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ApplicationQuestionAnswer, ApplicationQuestionInput, GeminiService, ResumeProfile } from '../../ai/gemini.service';
import { ResumesService } from '../../resumes/resumes.service';
import { assertValidId } from '../../database/db-utils';
import { Application } from '../../entities/application.entity';
import { Job } from '../../entities/job.entity';
import { User } from '../../entities/user.entity';
import { assertPublicHttpUrl } from '../assisted/url-safety';
import { SENSITIVE_LABEL } from '../assisted/assisted-apply.service';
import { FormField } from '../assisted/form-field.types';
import { ApplicationsService } from '../applications.service';
import { GuidedAnswersDto } from './dto/guided-answers.dto';
import { MarkAppliedDto } from './dto/mark-applied.dto';
import { StartGuidedDto, UpdateGuidedDetailsDto } from './dto/start-guided.dto';
import { FormLinkReader, ReadForm } from './form-link-reader.service';

export const DEFAULT_GUIDED_TITLE = 'Job application';

/** One question of the form and the answer the user can copy into it. */
export interface GuidedAnswer {
  id: string;
  question: string;
  /** Null when the app couldn't (or must not) answer - the user fills it in themselves. */
  answer: string | null;
  status: 'ANSWERED' | 'NEEDS_YOU';
  note?: string;
  kind?: string;
  required?: boolean;
  options?: string[];
}

/**
 * Guided ("copy & paste") apply. The user gives whatever they know about the job, pastes the
 * application form (or its link), and gets an answer for every question plus a tailored resume
 * and cover letter to copy into the real form. Nothing is ever submitted from here: when the
 * user has done it themselves they press "Applied" and the job is registered as applied.
 */
@Injectable()
export class GuidedApplyService {
  private readonly logger = new Logger(GuidedApplyService.name);

  constructor(
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(User) private users: Repository<User>,
    private gemini: GeminiService,
    private resumesService: ResumesService,
    private applicationsService: ApplicationsService,
    private linkReader: FormLinkReader,
  ) {}

  // ------------------------------------------------------------------ start / edit

  /** Step 1: create the application from the (all optional) job details. */
  async start(userId: string, dto: StartGuidedDto) {
    // Fail early, with the usual message, if the user has no resume to tailor from.
    const resume = dto.resumeId
      ? await this.resumesService.findOne(userId, dto.resumeId)
      : await this.resumesService.getPrimary(userId);
    const applyUrl = dto.applyUrl?.trim() ? await assertPublicHttpUrl(dto.applyUrl) : null;

    if (dto.jobId) {
      const app = await this.applicationsService.create(userId, { jobId: dto.jobId, resumeId: resume.id });
      if (app.status === 'SUBMITTED') throw new ConflictException('You have already applied for this job.');
      if (applyUrl) await this.applications.update({ id: app.id }, { appliedUrl: applyUrl });
      return this.applicationsService.getOwnedForResponse(userId, app.id);
    }

    const job = await this.jobs.save(
      this.jobs.create({
        source: 'manual',
        // Unique + private to this user (a shared job row would let one user's edits leak into another's).
        applyUrl: `manual://${randomUUID()}`,
        title: dto.jobTitle?.trim() || DEFAULT_GUIDED_TITLE,
        company: dto.company?.trim() || undefined,
        jobType: 'CUSTOM',
        description: this.composeDescription(dto.jobDescription, dto.requirements),
      }),
    );
    const app = await this.applications.save(
      this.applications.create({ userId, jobId: job.id, resumeId: resume.id, status: 'PENDING', appliedUrl: applyUrl }),
    );
    return this.applicationsService.getOwnedForResponse(userId, app.id);
  }

  /** The user adds/changes job details after starting (only for jobs they typed in themselves). */
  async updateDetails(userId: string, id: string, dto: UpdateGuidedDetailsDto) {
    const app = await this.applicationsService.getOwned(userId, id);
    const job = app.job;
    if (!job) throw new NotFoundException('Job not found');

    const patch: Partial<Job> = {};
    const touchesJob = dto.jobTitle !== undefined || dto.company !== undefined || dto.jobDescription !== undefined || dto.requirements !== undefined;
    if (touchesJob) {
      if (job.source !== 'manual') {
        throw new BadRequestException('The details of a job found by search cannot be edited.');
      }
      if (dto.jobTitle !== undefined) patch.title = dto.jobTitle.trim() || DEFAULT_GUIDED_TITLE;
      if (dto.company !== undefined) patch.company = dto.company.trim() || undefined;
      if (dto.jobDescription !== undefined || dto.requirements !== undefined) {
        const { description, requirements } = this.splitDescription(job.description);
        patch.description = this.composeDescription(dto.jobDescription ?? description, dto.requirements ?? requirements);
      }
      await this.jobs.update({ id: job.id }, patch as any);
    }
    if (dto.applyUrl !== undefined) {
      const url = dto.applyUrl.trim() ? await assertPublicHttpUrl(dto.applyUrl) : null;
      await this.applications.update({ id }, { appliedUrl: url });
    }
    return this.applicationsService.getOwnedForResponse(userId, id);
  }

  // ------------------------------------------------------------- answers + documents

  /** Step 2: answer every question on the pasted form text, or on the form behind a link. */
  async answer(userId: string, id: string, dto: GuidedAnswersDto) {
    const app = await this.applicationsService.getOwned(userId, id);
    this.assertOpen(app);
    const formText = dto.formText?.trim();
    if (!formText && !dto.applyUrl?.trim() && !app.appliedUrl) {
      throw new BadRequestException('Paste the application form (or a link to it) so there is something to answer.');
    }

    let read: ReadForm | null = null;
    let questions: ApplicationQuestionInput[] | undefined;
    let fields: FormField[] = [];
    let source: 'pasted' | 'link' = 'pasted';

    if (!formText) {
      // Link mode: the link in this request, else the one saved on the application.
      source = 'link';
      const link = dto.applyUrl?.trim() || app.appliedUrl!;
      read = await this.linkReader.read(link);
      fields = read.fields;
      if (!fields.length && read.text.trim().length < 80) {
        throw new BadRequestException(
          "Couldn't find any questions at that link (it may need you to sign in). Copy the form from the page and paste it instead.",
        );
      }
      questions = fields.length
        ? fields.map((f) => ({
            id: f.id,
            question: f.label || f.placeholder || f.name || 'Unlabelled field',
            kind: f.kind,
            required: f.required,
            options: f.options?.map((o) => o.label),
          }))
        : undefined;
      await this.enrichJobFromPage(app, read);
      if (dto.applyUrl?.trim()) await this.applications.update({ id }, { appliedUrl: read.url });
    }

    const { job, profile } = await this.context(userId, app);
    // With no structured fields (link had none / pasted text), the model works from raw text.
    const rawText = formText || (!fields.length ? read?.text : undefined);
    const docs = await this.documentTexts(userId, id);

    const raw = await this.gemini.answerApplicationQuestions(userId, profile, job, { questions, formText: rawText });
    const answers = this.normalise(raw, questions, docs);
    if (!answers.length) {
      throw new BadRequestException("Couldn't find any questions in that form. Make sure you copied the fields, not just the page title.");
    }

    await this.applications.update({ id }, { guidedAnswers: answers as any });
    return {
      source,
      via: read?.via,
      pageTitle: read?.title || undefined,
      answers,
      needsYou: answers.filter((a) => a.status === 'NEEDS_YOU').length,
    };
  }

  /** Step 3: the tailored resume + cover letter. */
  async generateDocuments(userId: string, id: string) {
    const app = await this.applicationsService.getOwned(userId, id);
    this.assertOpen(app);
    return this.applicationsService.generateDocuments(userId, id);
  }

  /**
   * One click: tailored documents first (so a "paste your cover letter" box can be answered with the
   * real thing), then the answers. A failure in one part doesn't throw away the other.
   */
  async prepare(userId: string, id: string, dto: GuidedAnswersDto) {
    const app = await this.applicationsService.getOwned(userId, id);
    this.assertOpen(app);
    const errors: { documents?: string; answers?: string } = {};

    try {
      await this.applicationsService.generateDocuments(userId, id);
    } catch (err) {
      errors.documents = this.messageOf(err);
    }

    let answered: Awaited<ReturnType<GuidedApplyService['answer']>> | null = null;
    const hasForm = !!(dto.formText?.trim() || dto.applyUrl?.trim() || app.appliedUrl);
    if (hasForm) {
      try {
        answered = await this.answer(userId, id, dto);
      } catch (err) {
        errors.answers = this.messageOf(err);
      }
    }
    if (errors.documents && errors.answers) {
      throw new BadRequestException({ message: 'Nothing could be generated.', errors });
    }
    return { application: await this.applicationsService.getOwnedForResponse(userId, id), answers: answered, errors };
  }

  // ------------------------------------------------------------------- applied

  /** Final step: the user pasted everything into the real form and submitted it - register the job as applied. */
  async markApplied(userId: string, id: string, dto: MarkAppliedDto) {
    const app = await this.applicationsService.getOwned(userId, id);
    if (app.status !== 'SUBMITTED') {
      const note = dto.note?.trim();
      await this.applications.update(
        { id },
        {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          feedback: `Applied by you${app.appliedUrl ? ` via ${this.hostOf(app.appliedUrl)}` : ''}.${note ? `\nNote: ${note}` : ''}`,
        },
      );
    }
    return this.applicationsService.getOwnedForResponse(userId, id);
  }

  /** Undo a mis-click on "Applied". */
  async undoApplied(userId: string, id: string) {
    const app = await this.applicationsService.getOwned(userId, id);
    if (app.status === 'SUBMITTED') {
      const hasDocs = !!(await this.documentTexts(userId, id)).resume;
      await this.applications.update({ id }, { status: hasDocs ? 'READY' : 'PENDING', submittedAt: null, feedback: null });
    }
    return this.applicationsService.getOwnedForResponse(userId, id);
  }

  // ------------------------------------------------------------------- helpers

  private assertOpen(app: Application) {
    if (app.status === 'SUBMITTED') {
      throw new ConflictException('This application is already marked as applied.');
    }
  }

  private composeDescription(description?: string, requirements?: string): string {
    const d = (description || '').trim();
    const r = (requirements || '').trim();
    return r ? `${d}${d ? '\n\n' : ''}Requirements:\n${r}` : d;
  }

  private splitDescription(full: string): { description: string; requirements: string } {
    const i = (full || '').indexOf('\n\nRequirements:\n');
    if (i >= 0) return { description: full.slice(0, i), requirements: full.slice(i + '\n\nRequirements:\n'.length) };
    if ((full || '').startsWith('Requirements:\n')) return { description: '', requirements: full.slice('Requirements:\n'.length) };
    return { description: full || '', requirements: '' };
  }

  private async context(userId: string, app: Application) {
    const resume = await this.resumesService.findOne(userId, String(app.resumeId));
    const user = await this.users.findOneBy({ id: userId });
    const base = (resume.parsedProfile || { skills: [], experience: [], education: [] }) as ResumeProfile;
    const profile = {
      ...base,
      fullName: base.fullName || `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || undefined,
      email: base.email || user?.email,
      phone: base.phone || user?.phone,
      location: base.location || user?.location,
      linkedinUrl: user?.linkedinUrl,
      portfolioUrl: user?.portfolioUrl,
    };
    const j = await this.jobs.findOneBy({ id: app.jobId });
    const job = {
      title: j?.title && j.title !== DEFAULT_GUIDED_TITLE ? j.title : 'the role in the application form',
      company: j?.company || 'the company',
      description: j?.description || '',
    };
    return { job, profile };
  }

  /** A link told us what the job is - fill in whatever the user left blank on their own manual job. */
  private async enrichJobFromPage(app: Application, read: ReadForm) {
    const job = app.job;
    if (!job || job.source !== 'manual') return;
    const patch: Partial<Job> = {};
    if (!job.description?.trim() && read.text) patch.description = read.text.slice(0, 6000);
    if (job.title === DEFAULT_GUIDED_TITLE && read.title) {
      const t = read.title.split(/[|\u2013\u2014-]/)[0].trim();
      if (t) patch.title = t.slice(0, 200);
    }
    if (!job.company && read.siteName) patch.company = read.siteName.slice(0, 200);
    if (Object.keys(patch).length) {
      await this.jobs.update({ id: job.id }, patch as any);
      Object.assign(job, patch);
    }
  }

  private async documentTexts(userId: string, applicationId: string): Promise<{ resume?: string; coverLetter?: string }> {
    const app: any = await this.applicationsService.getOwnedForResponse(userId, applicationId);
    const docs: any[] = app.documents || [];
    return {
      resume: docs.find((d) => d.type === 'RESUME')?.content,
      coverLetter: docs.find((d) => d.type === 'COVER_LETTER')?.content,
    };
  }

  /**
   * Cleans up what the model returned: every extracted field gets an entry, option answers must match a
   * real option, sensitive questions are never answered, and the cover-letter / resume placeholders
   * are replaced with the generated documents.
   */
  private normalise(
    raw: ApplicationQuestionAnswer[],
    questions: ApplicationQuestionInput[] | undefined,
    docs: { resume?: string; coverLetter?: string },
  ): GuidedAnswer[] {
    const build = (item: ApplicationQuestionAnswer | undefined, q: ApplicationQuestionInput | undefined, i: number): GuidedAnswer | null => {
      const question = (q?.question || item?.question || '').replace(/\s+/g, ' ').trim();
      if (!question) return null;
      let answer: string | null = typeof item?.answer === 'string' && item.answer.trim() ? item.answer.trim() : null;
      let note = item?.note ? String(item.note).slice(0, 200) : undefined;

      if (SENSITIVE_LABEL.test(question)) {
        answer = null;
        note = 'Personal or legal question - answer this yourself.';
      } else if (answer === '{{COVER_LETTER}}') {
        answer = docs.coverLetter?.trim() || null;
        if (!answer) note = 'Generate your cover letter first, then paste it here.';
      } else if (answer === '{{RESUME}}') {
        answer = docs.resume?.trim() || null;
        if (!answer) note = 'Generate your resume first, then paste it here.';
      } else if (answer && q?.options?.length && (q.kind === 'select' || q.kind === 'radio' || q.kind === 'checkbox-group')) {
        const matched = this.matchOptions(answer, q.options, q.kind === 'checkbox-group');
        if (matched) answer = matched;
        else {
          answer = null;
          note = 'Pick the option that applies to you.';
        }
      }
      if (answer) answer = answer.slice(0, 6000);
      return {
        id: q?.id || item?.id || `q${i + 1}`,
        question,
        answer,
        status: answer ? 'ANSWERED' : 'NEEDS_YOU',
        note: answer ? note : note || 'Not enough information in your profile - answer this one yourself.',
        kind: q?.kind,
        required: q?.required,
        options: q?.options,
      };
    };

    const out: GuidedAnswer[] = [];
    if (questions?.length) {
      // Every field we found is accounted for, in page order, even if the model skipped it.
      questions.forEach((q, i) => {
        const item = raw.find((r) => r?.id === q.id);
        const a = build(item, q, i);
        if (a) out.push(a);
      });
    } else {
      raw.forEach((item, i) => {
        const a = build(item, undefined, i);
        if (a) out.push(a);
      });
    }
    // De-duplicate ids defensively (the model sometimes repeats "q1").
    const seen = new Set<string>();
    return out.map((a, i) => {
      if (seen.has(a.id)) a.id = `q${i + 1}-${randomUUID().slice(0, 4)}`;
      seen.add(a.id);
      return a;
    });
  }

  private matchOptions(answer: string, options: string[], multi: boolean): string | null {
    const find = (s: string) => options.find((o) => o.trim().toLowerCase() === s.trim().toLowerCase());
    const whole = find(answer);
    if (whole) return whole;
    if (!multi) return null;
    const parts = answer.split(/\s*[,;]\s*/).map(find);
    return parts.length && parts.every(Boolean) ? (parts as string[]).join(', ') : null;
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private messageOf(err: unknown): string {
    const r: any = (err as any)?.response;
    return String(r?.message || (err as Error)?.message || 'Unknown error').split('\n')[0];
  }
}
