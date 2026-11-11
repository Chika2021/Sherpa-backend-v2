import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Browser, BrowserContext, Frame, Page, chromium } from 'playwright';
import { AiFieldAnswer, GeminiService, ResumeProfile } from '../../ai/gemini.service';
import { CredentialsService, DecryptedSiteCredential } from '../../credentials/credentials.service';
import { ResumesService } from '../../resumes/resumes.service';
import { assertValidId } from '../../database/db-utils';
import { upsertJob } from '../../jobs/utils/upsert-job';
import { Application } from '../../entities/application.entity';
import { Job } from '../../entities/job.entity';
import { User } from '../../entities/user.entity';
import { ApplicationStatus } from '../../entities/enums';
import { SubmissionProfile } from '../adapters/application-submitter.interface';
import { GenericFormAdapter } from '../adapters/generic-form.adapter';
import { ApplicationsService } from '../applications.service';
import { mapBasicField } from './basic-field-mapper';
import { AnswerFieldsDto } from './dto/answer-fields.dto';
import { PrepareFromLinkDto } from './dto/prepare-from-link.dto';
import { SubmitAssistedDto } from './dto/submit-assisted.dto';
import { FieldSource, FieldState, FieldValue, FormField } from './form-field.types';
import {
  detectSubmitOutcome,
  fillField,
  findSubmitButton,
  inspectForm,
  readPageSummary,
  resolveOption,
} from './form-inspector';
import { assertPublicHttpUrl, isPublicRequestUrl } from './url-safety';

export type AssistedStatus =
  | 'PREPARING'
  | 'READY_FOR_REVIEW'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'SUBMITTED_UNCONFIRMED'
  | 'NEEDS_MANUAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

const LIVE: AssistedStatus[] = ['PREPARING', 'READY_FOR_REVIEW', 'SUBMITTING'];

/**
 * Questions we never let the AI answer, regardless of what the model returns.
 * The prompt already says this; this is the belt to that pair of braces.
 * These are personal or legal statements the candidate has to make
 * themselves - a wrong or invented answer can disqualify them or amount to a
 * false declaration.
 */
export const SENSITIVE_LABEL =
  /gender|\bsex\b|\brace\b|ethnic|veteran|disabilit|sponsor|authori[sz]ed to work|work authori[sz]ation|right to work|\bvisa\b|citizen|criminal|convict|felony|salary|compensation|pay expect|date of birth|\bdob\b|social security|\bssn\b|national id|signature|\bi (agree|certify|consent|acknowledge|declare|confirm)\b|\bterms\b|privacy|notice period|start date|available to start|\breferences?\b/i;

interface Session {
  id: string;
  userId: string;
  status: AssistedStatus;
  message?: string;
  applyUrl: string;
  resumeId?: string;
  jobId?: string;
  applicationId?: string;
  job?: { title: string; company: string; description: string };
  fields: FieldState[];
  siteErrors: string[];
  submitLabel?: string;
  multiStep: boolean;
  screenshot?: Buffer;
  screenshotVersion: number;
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
  busy: boolean;
  // Live browser handles - never leave this class.
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  frame?: Frame;
  // Server-side only.
  files: { resumePath?: string; coverLetterPath?: string };
}

@Injectable()
export class AssistedApplyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistedApplyService.name);
  private readonly sessions = new Map<string, Session>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly maxLive: number;

  constructor(
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(User) private users: Repository<User>,
    private config: ConfigService,
    private gemini: GeminiService,
    private resumesService: ResumesService,
    private applicationsService: ApplicationsService,
    private credentialsService: CredentialsService,
    private adapter: GenericFormAdapter,
  ) {
    this.ttlMs = Number(this.config.get('ASSISTED_SESSION_TTL_MINUTES') || 20) * 60_000;
    this.maxLive = Number(this.config.get('ASSISTED_MAX_SESSIONS') || 3);
  }

  onModuleInit() {
    this.sweepTimer = setInterval(() => void this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  async onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all([...this.sessions.values()].map((s) => this.closeBrowser(s)));
  }

  // ---------------------------------------------------------------- public API

  /** Step 1: the user pasted a link. Kicks off the (slow) fill in the background and returns immediately. */
  async prepare(userId: string, dto: PrepareFromLinkDto) {
    const applyUrl = await assertPublicHttpUrl(dto.applyUrl);

    if (dto.jobId) {
      assertValidId(dto.jobId, 'Job');
      assertValidId(userId, 'User');
      const job = await this.jobs.findOneBy({ id: dto.jobId });
      if (!job) throw new NotFoundException('Job not found');
      const existing = await this.applications.findOne({ where: { userId, jobId: dto.jobId } });
      if (existing?.status === 'SUBMITTED') {
        throw new ConflictException('You have already submitted an application for this job.');
      }
    }

    // One live session per user - starting a new one replaces the old one.
    for (const s of this.sessions.values()) {
      if (s.userId === userId && LIVE.includes(s.status)) {
        await this.terminate(s, 'CANCELLED', 'Replaced by a newer session.');
      }
    }
    const liveCount = [...this.sessions.values()].filter((s) => LIVE.includes(s.status)).length;
    if (liveCount >= this.maxLive) {
      throw new ServiceUnavailableException('Too many applications are being prepared right now. Try again in a minute.');
    }

    const session: Session = {
      id: randomUUID(),
      userId,
      status: 'PREPARING',
      message: 'Opening the application page...',
      applyUrl,
      resumeId: dto.resumeId,
      jobId: dto.jobId,
      fields: [],
      siteErrors: [],
      multiStep: false,
      screenshotVersion: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      busy: true,
      files: {},
    };
    this.sessions.set(session.id, session);

    void this.runPrepare(session, dto).finally(() => {
      session.busy = false;
    });

    return this.view(session);
  }

  getView(userId: string, id: string) {
    return this.view(this.owned(userId, id));
  }

  getActive(userId: string) {
    const s = [...this.sessions.values()]
      .filter((x) => x.userId === userId && LIVE.includes(x.status))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return s ? this.view(s) : null;
  }

  getScreenshot(userId: string, id: string): Buffer {
    const s = this.owned(userId, id);
    if (!s.screenshot) throw new NotFoundException('No screenshot available yet.');
    return s.screenshot;
  }

  /** The user filled in (or corrected) some fields in the app's review screen - push those into the live form. */
  async answer(userId: string, id: string, dto: AnswerFieldsDto) {
    const s = this.owned(userId, id);
    this.assertReady(s);
    s.busy = true;
    const failed: Array<{ fieldId: string; error: string }> = [];
    try {
      for (const a of dto.answers) {
        const state = s.fields.find((f) => f.id === a.fieldId);
        if (!state) {
          failed.push({ fieldId: a.fieldId, error: 'Unknown field.' });
          continue;
        }
        if (state.kind === 'file' || state.kind === 'unsupported') {
          failed.push({ fieldId: a.fieldId, error: 'This field cannot be filled from here - finish it on the site.' });
          continue;
        }
        const value = this.checkValueShape(a.value);
        const err = await this.tryFill(s, state, value, 'user');
        if (err) failed.push({ fieldId: a.fieldId, error: err });
      }
      s.expiresAt = Date.now() + this.ttlMs;
      await this.refreshPage(s);
    } finally {
      s.busy = false;
    }
    return { ...this.view(s), failed };
  }

  /** The user pressed Submit in the app. This is the only place the real form is ever submitted. */
  async submit(userId: string, id: string, dto: SubmitAssistedDto) {
    const s = this.owned(userId, id);
    this.assertReady(s);
    if (!s.page || !s.frame) throw new ConflictException('This session is no longer open.');

    const blocking = s.fields.filter((f) => f.required && f.status !== 'FILLED' && f.status !== 'PREFILLED');
    if (blocking.length && !dto.force) {
      throw new BadRequestException({
        message: 'Some required fields are still empty.',
        blocking: blocking.map((f) => ({ id: f.id, label: f.label, status: f.status })),
      });
    }

    s.busy = true;
    s.status = 'SUBMITTING';
    s.siteErrors = [];
    await this.setApplication(s, 'SUBMITTING');

    try {
      // Re-find the button: the DOM may have changed since it was first tagged.
      const btn = await findSubmitButton(s.frame);
      if (!btn.found) {
        return this.backToReview(s, "Couldn't find the submit button any more. The page may have changed.");
      }
      try {
        await s.frame.locator('[data-ja-submit="1"]').first().click({ timeout: 8000 });
      } catch (err) {
        return this.backToReview(s, `Couldn't press the submit button (${(err as Error).message.split('\n')[0]}).`);
      }

      const outcome = await detectSubmitOutcome(s.page, s.frame);
      await this.snapshot(s);

      if (outcome.kind === 'errors') {
        s.siteErrors = outcome.errors;
        return this.backToReview(s, 'The site flagged some problems with the form. Nothing was submitted yet.');
      }

      const host = this.hostOf(s.applyUrl);
      if (outcome.kind === 'success') {
        await this.terminate(s, 'SUBMITTED', 'Application submitted.');
        await this.setApplication(s, 'SUBMITTED', `Submitted via ${host} after your review.`, new Date());
      } else {
        const msg =
          'You pressed Submit, but the site did not show a clear confirmation. Check your email or the job site to make sure it went through.';
        await this.terminate(s, 'SUBMITTED_UNCONFIRMED', msg);
        await this.setApplication(s, 'MANUAL_REVIEW', `${msg}\nLink: ${s.applyUrl}`);
      }
      return this.view(s);
    } catch (err) {
      this.logger.error(`Assisted submit failed for session ${s.id}: ${err}`);
      return this.backToReview(s, `Something went wrong while submitting: ${(err as Error).message}`);
    } finally {
      s.busy = false;
    }
  }

  async cancel(userId: string, id: string) {
    const s = this.owned(userId, id);
    if (LIVE.includes(s.status)) {
      await this.terminate(s, 'CANCELLED', 'Cancelled.');
      if (s.applicationId) {
        const app = await this.applications.findOneBy({ id: s.applicationId });
        if (app?.status === 'AWAITING_REVIEW') await this.setApplication(s, 'READY', 'Assisted apply was cancelled before submitting.');
      }
    }
    return this.view(s);
  }

  // ------------------------------------------------------------- prepare pipeline

  private async runPrepare(s: Session, dto: PrepareFromLinkDto) {
    try {
      const resume = dto.resumeId
        ? await this.resumesService.findOne(s.userId, dto.resumeId)
        : await this.resumesService.getPrimary(s.userId);
      s.resumeId = resume.id;
      const profile = (resume.parsedProfile || {}) as ResumeProfile;
      const user = await this.users.findOneBy({ id: s.userId });
      const submission = this.buildProfile(profile, user);

      if (s.jobId) {
        const j = await this.jobs.findOneBy({ id: s.jobId });
        if (j) s.job = { title: j.title, company: j.company || this.hostOf(s.applyUrl), description: j.description };
      }

      // 1. Open the page (signing in first if the user stored credentials for this site).
      const credentials = await this.credentialsFor(s);
      await this.launch(s);
      const scratch = join(tmpdir(), `ja-${s.id}`);
      let opened: Awaited<ReturnType<GenericFormAdapter['openApplyPage']>>;
      try {
        opened = await this.adapter.openApplyPage(s.page!, s.applyUrl, submission, credentials, scratch);
      } catch (err) {
        return this.needsManual(s, `Couldn't open that page (${(err as Error).message.split('\n')[0]}). Check the link and try again.`);
      }
      if (!opened.ok) {
        if (opened.result.screenshotPath) await unlink(opened.result.screenshotPath).catch(() => undefined);
        return this.needsManual(s, opened.result.message);
      }
      s.frame = opened.frame;

      // 2. Bail out early (before spending any AI tokens) if a human is required.
      if (await this.adapter.pageHasCaptcha(s.frame)) {
        return this.needsManual(
          s,
          'This form has a CAPTCHA, which cannot be completed from the server. Please apply directly on the site.',
        );
      }
      const inspected = await inspectForm(s.frame);
      if (!inspected.fields.length) {
        return this.needsManual(s, "Couldn't find any fillable fields on that page. It may be a listing page - open the actual application form and paste that link.");
      }

      // 3. Job + application record + tailored documents.
      s.message = 'Preparing your tailored resume and cover letter...';
      if (!s.job) await this.buildJobFromPage(s, dto);
      await this.ensureApplication(s);
      await this.applications.update({ id: s.applicationId }, { appliedUrl: s.applyUrl });
      const docs = await this.ensureDocuments(s);
      s.files = { resumePath: docs.resumePath, coverLetterPath: docs.coverLetterPath };

      // 4. Fill: rule-based first, AI for the leftovers.
      s.message = 'Filling in the form...';
      s.fields = inspected.fields.map((f) => this.initialState(f));
      const basicCtx = {
        profile: submission,
        coverLetterText: docs.coverLetterText,
        fileCount: inspected.fileCount,
        hasCoverLetterFile: !!docs.coverLetterPath,
      };
      for (const state of s.fields) {
        if (state.status !== 'NEEDS_INPUT') continue;
        const mapped = mapBasicField(state, basicCtx);
        if (!mapped) continue;
        if ('file' in mapped) {
          const path = mapped.file === 'resume' ? docs.resumePath : docs.coverLetterPath;
          if (path) await this.tryFill(s, state, path, 'document', mapped.file === 'resume' ? 'Tailored resume' : 'Tailored cover letter');
        } else {
          await this.tryFill(s, state, mapped.value, mapped.source);
        }
      }
      await this.fillWithAi(s, profile, docs.coverLetterText);

      // 5. Is there a real Submit button we can hand to the user?
      await this.refreshPage(s);
      const filled = s.fields.filter((f) => f.status === 'FILLED').length;

      if (s.multiStep || !s.submitLabel) {
        return this.needsManual(
          s,
          s.multiStep
            ? `This is a multi-step form. I filled ${filled} field(s) on the first step, but can only submit single-page forms - please finish it on the site.`
            : `I filled ${filled} field(s) but couldn't find a submit button - please finish it on the site.`,
          true,
        );
      }

      s.status = 'READY_FOR_REVIEW';
      s.busy = false;
      const open = s.fields.filter((f) => f.status === 'NEEDS_INPUT' || f.status === 'UNSUPPORTED').length;
      s.message = open
        ? `Filled ${filled} field(s). ${open} still need your attention - check them below, then press Submit.`
        : `Filled ${filled} field(s). Review everything, then press Submit.`;
      s.expiresAt = Date.now() + this.ttlMs;
      await this.setApplication(s, 'AWAITING_REVIEW', `Form filled on ${this.hostOf(s.applyUrl)}; waiting for you to review and submit.`);
    } catch (err) {
      this.logger.error(`Assisted prepare failed for session ${s.id}: ${err}`);
      await this.terminate(s, 'FAILED', this.friendlyError(err));
      if (s.applicationId) await this.setApplication(s, 'FAILED', s.message);
    }
  }

  private async fillWithAi(s: Session, profile: ResumeProfile, coverLetterText: string) {
    const candidates = s.fields.filter(
      (f) => f.status === 'NEEDS_INPUT' && f.kind !== 'file' && f.kind !== 'unsupported',
    );
    if (!candidates.length || !s.job) return;

    let answers: AiFieldAnswer[] = [];
    try {
      answers = await this.gemini.mapFormFields(
        s.userId,
        profile,
        s.job,
        candidates.map((f) => ({
          fieldId: f.id,
          kind: f.kind,
          inputType: f.inputType,
          label: f.label,
          required: f.required,
          options: f.options?.map((o) => ({ value: o.value, label: o.label })),
        })),
      );
    } catch (err) {
      // Not fatal: the user can answer these themselves.
      this.logger.warn(`AI field mapping unavailable for session ${s.id}: ${(err as Error).message}`);
      s.message = 'AI suggestions were unavailable, so some fields are left for you.';
      return;
    }

    for (const state of candidates) {
      const answer = answers.find((a) => a.fieldId === state.id);
      if (SENSITIVE_LABEL.test(state.label)) {
        state.reason = 'Personal or legal question - answer this one yourself.';
        continue;
      }
      if (!answer || answer.value === null || answer.value === undefined) {
        state.reason = answer?.reason || 'Not enough information in your profile to answer this.';
        continue;
      }
      let value = this.coerceAiValue(state, answer.value);
      if (value === '{{COVER_LETTER}}') value = coverLetterText || null;
      if (value === null) {
        state.reason = 'The suggested answer did not match this field.';
        continue;
      }
      await this.tryFill(s, state, value, 'ai', undefined, answer.reason);
    }
  }

  /** Validates a model-proposed value against the field; returns null if it doesn't fit. */
  private coerceAiValue(field: FormField, raw: unknown): FieldValue | null {
    switch (field.kind) {
      case 'text':
      case 'textarea':
        return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 4000) : null;
      case 'select':
      case 'radio': {
        const opt = resolveOption(field, raw);
        return opt ? opt.value : null;
      }
      case 'checkbox':
        return typeof raw === 'boolean' ? raw : null;
      case 'checkbox-group': {
        const arr = Array.isArray(raw) ? raw : [raw];
        const opts = arr.map((v) => resolveOption(field, v));
        return opts.length && opts.every(Boolean) ? opts.map((o) => o!.value) : null;
      }
      default:
        return null;
    }
  }

  /** Fills one field and records the result on its state. Returns an error message on failure. */
  private async tryFill(
    s: Session,
    state: FieldState,
    value: FieldValue,
    source: FieldSource,
    display?: string,
    reason?: string,
  ): Promise<string | null> {
    try {
      await fillField(s.frame!, state, value);
      state.status = 'FILLED';
      state.source = source;
      state.value = display ?? value;
      state.reason = reason;
      return null;
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0];
      state.reason = `Couldn't fill this automatically (${msg}).`;
      return msg;
    }
  }

  private initialState(f: FormField): FieldState {
    if (f.hasValue) return { ...f, status: 'PREFILLED', source: 'site' };
    if (f.kind === 'unsupported') return { ...f, status: 'UNSUPPORTED' };
    return { ...f, status: 'NEEDS_INPUT' };
  }

  /** Re-checks the submit button and takes a fresh screenshot. */
  private async refreshPage(s: Session) {
    if (!s.frame) return;
    const btn = await findSubmitButton(s.frame);
    s.submitLabel = btn.found ? btn.label : undefined;
    s.multiStep = !btn.found && !!btn.next;
    await this.snapshot(s);
  }

  // ------------------------------------------------------------------- helpers

  private async launch(s: Session) {
    s.browser = await chromium.launch({ headless: true });
    s.context = await s.browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    // Every request the page makes - including redirects - must stay on the public internet.
    await s.context.route('**/*', async (route) => {
      if (await isPublicRequestUrl(route.request().url())) return route.continue();
      return route.abort('blockedbyclient');
    });
    s.page = await s.context.newPage();
    s.page.setDefaultTimeout(15_000);
    s.page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    s.context.on('page', (p) => {
      if (p !== s.page) void p.close().catch(() => undefined);
    });
  }

  private async closeBrowser(s: Session) {
    const b = s.browser;
    s.browser = undefined;
    s.context = undefined;
    s.page = undefined;
    s.frame = undefined;
    if (b) await b.close().catch(() => undefined);
  }

  private async terminate(s: Session, status: AssistedStatus, message: string) {
    s.status = status;
    s.message = message;
    s.closedAt = Date.now();
    await this.closeBrowser(s);
  }

  private async needsManual(s: Session, message: string, keepScreenshotOfFilled = false) {
    if (!keepScreenshotOfFilled) await this.snapshot(s);
    await this.terminate(s, 'NEEDS_MANUAL', message);
    await this.ensureApplication(s).catch(() => undefined);
    if (s.applicationId) {
      await this.setApplication(s, 'MANUAL_REVIEW', `${message}\nFinish it yourself here: ${s.applyUrl}`);
    }
  }

  private async backToReview(s: Session, message: string) {
    s.status = 'READY_FOR_REVIEW';
    s.message = message;
    s.expiresAt = Date.now() + this.ttlMs;
    s.busy = false;
    await this.setApplication(s, 'AWAITING_REVIEW');
    await this.refreshPage(s).catch(() => undefined);
    return this.view(s);
  }

  private async snapshot(s: Session) {
    if (!s.page) return;
    try {
      s.screenshot = await s.page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
    } catch {
      // Very tall pages can exceed Chromium's capture limit - fall back to what's visible.
      s.screenshot = await s.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => s.screenshot);
    }
    s.screenshotVersion += 1;
  }

  private async setApplication(s: Session, status: ApplicationStatus, feedback?: string, submittedAt?: Date) {
    if (!s.applicationId) return;
    const patch: Partial<Application> = { status };
    if (feedback !== undefined) patch.feedback = feedback;
    if (submittedAt) patch.submittedAt = submittedAt;
    await this.applications.update({ id: s.applicationId, userId: s.userId }, patch as any);
  }

  private async ensureApplication(s: Session) {
    if (s.applicationId || !s.jobId) return;
    const app = await this.applicationsService.create(s.userId, { jobId: s.jobId, resumeId: s.resumeId });
    if (app.status === 'SUBMITTED') throw new ConflictException('You have already submitted an application for this job.');
    s.applicationId = app.id;
  }

  private async buildJobFromPage(s: Session, dto: PrepareFromLinkDto) {
    const summary = await readPageSummary(s.page!);
    const host = this.hostOf(s.applyUrl);
    const title = dto.jobTitle?.trim() || summary.title.split(/[|\u2013\u2014-]/)[0].trim() || 'Role';
    const company = dto.company?.trim() || summary.siteName || host;
    const job = await upsertJob(
      this.jobs,
      { source: 'pasted-link', externalId: s.applyUrl, applyUrl: s.applyUrl },
      { title, company, jobType: 'CUSTOM', description: summary.text || title },
    );
    s.jobId = job.id;
    s.job = { title, company, description: job.description };
  }

  private async ensureDocuments(s: Session) {
    const app = await this.applicationsService.getOwnedForResponse(s.userId, s.applicationId!);
    const docs: any[] = app.documents || [];
    let resume = docs.find((d) => d.type === 'RESUME');
    let cover = docs.find((d) => d.type === 'COVER_LETTER');
    if (!resume || !cover) {
      const generated = await this.applicationsService.generateDocuments(s.userId, s.applicationId!);
      resume = generated.resume;
      cover = generated.coverLetter;
    }
    return {
      resumePath: resume.filePath as string,
      coverLetterPath: cover?.filePath as string | undefined,
      coverLetterText: (cover?.content as string | undefined) || '',
    };
  }

  private async credentialsFor(s: Session): Promise<DecryptedSiteCredential | null> {
    try {
      return await this.credentialsService.findForDomain(s.userId, new URL(s.applyUrl).hostname);
    } catch {
      return null;
    }
  }

  private buildProfile(profile: ResumeProfile, user: User | null): SubmissionProfile {
    const userName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
    return {
      fullName: profile.fullName || userName || undefined,
      email: profile.email || user?.email,
      phone: profile.phone || user?.phone,
      location: profile.location || user?.location,
      linkedinUrl: user?.linkedinUrl,
      portfolioUrl: user?.portfolioUrl,
    };
  }

  private checkValueShape(v: unknown): FieldValue {
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
    throw new BadRequestException('Answer values must be a string, a boolean, or a list of strings.');
  }

  private owned(userId: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.userId !== userId) throw new NotFoundException('Session not found');
    return s;
  }

  private assertReady(s: Session) {
    if (s.status !== 'READY_FOR_REVIEW') {
      throw new ConflictException(`This session is not waiting for review (status: ${s.status}).`);
    }
    if (s.busy) throw new ConflictException('This session is busy - try again in a moment.');
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private friendlyError(err: unknown): string {
    const msg = (err as any)?.response?.message || (err as Error)?.message || 'Unknown error';
    return `Something went wrong while preparing this application: ${String(msg).split('\n')[0]}`;
  }

  private view(s: Session) {
    const canSubmit = s.status === 'READY_FOR_REVIEW' && !!s.submitLabel && !s.busy;
    return {
      id: s.id,
      status: s.status,
      message: s.message,
      applyUrl: s.applyUrl,
      jobId: s.jobId,
      applicationId: s.applicationId,
      job: s.job ? { title: s.job.title, company: s.job.company } : undefined,
      fields: s.fields.map((f) => ({
        id: f.id,
        kind: f.kind,
        inputType: f.inputType,
        label: f.label,
        required: f.required,
        options: f.options?.map((o) => ({ value: o.value, label: o.label })),
        status: f.status,
        source: f.source,
        value: f.value,
        reason: f.reason,
        note: f.note,
      })),
      needsAttention: s.fields.filter((f) => f.status === 'NEEDS_INPUT' || f.status === 'UNSUPPORTED').map((f) => f.id),
      siteErrors: s.siteErrors,
      canSubmit,
      submitButtonLabel: s.submitLabel,
      screenshotVersion: s.screenshotVersion,
      expiresAt: LIVE.includes(s.status) ? new Date(s.expiresAt).toISOString() : undefined,
    };
  }

  /** Runs every 30s: closes browsers for sessions the user walked away from, and forgets old finished ones. */
  private async sweep() {
    try {
      await this.sweepOnce();
    } catch (err) {
      this.logger.warn(`Session sweep failed: ${(err as Error).message}`);
    }
  }

  private async sweepOnce() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (LIVE.includes(s.status) && !s.busy && now > s.expiresAt) {
        await this.terminate(s, 'EXPIRED', 'This session timed out before you submitted. Start again from the link when you are ready.');
        if (s.applicationId) {
          const app = await this.applications.findOneBy({ id: s.applicationId }).catch(() => null);
          if (app?.status === 'AWAITING_REVIEW') {
            await this.setApplication(s, 'READY', `The assisted session timed out before you submitted. Apply here: ${s.applyUrl}`).catch(() => undefined);
          }
        }
      } else if (!LIVE.includes(s.status) && s.closedAt && now - s.closedAt > 30 * 60_000) {
        this.sessions.delete(s.id); // drops the screenshot from memory too
      }
    }
  }
}
