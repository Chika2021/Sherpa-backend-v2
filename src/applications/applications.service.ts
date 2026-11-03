import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ResumesService } from '../resumes/resumes.service';
import { DocumentsService } from '../documents/documents.service';
import { SubmitterRegistry } from './adapters/submitter-registry.service';
import { CredentialsService, DecryptedSiteCredential } from '../credentials/credentials.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { GenerateForJobDto } from './dto/generate-for-job.dto';
import { RecordResultDto } from './dto/record-result.dto';
import { Application } from '../entities/application.entity';
import { Job } from '../entities/job.entity';
import { GeneratedDocument } from '../entities/generated-document.entity';
import { ApplicationStatus } from '../entities/enums';
import { assertValidId, ownedBy } from '../database/db-utils';

/**
 * The `user` relation is loaded so the submitter can read the applicant's name, but it is
 * serialised into API responses too - so strip the credential fields first. (The previous
 * Mongo version returned the populated user verbatim, password hash included.)
 */
export function stripUserSecrets(user: any) {
  if (!user) return user;
  const json = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
  delete json.passwordHash;
  delete json.passwordResetTokenHash;
  delete json.passwordResetExpiresAt;
  return json;
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(GeneratedDocument) private documents: Repository<GeneratedDocument>,
    private resumesService: ResumesService,
    private documentsService: DocumentsService,
    private submitterRegistry: SubmitterRegistry,
    private credentialsService: CredentialsService,
  ) {}

  async create(userId: string, dto: CreateApplicationDto, autoApplyBatchId?: string) {
    assertValidId(dto.jobId, 'Job');
    assertValidId(userId, 'User');
    const job = await this.jobs.findOneBy({ id: dto.jobId });
    if (!job) throw new NotFoundException('Job not found');

    const resume = dto.resumeId
      ? await this.resumesService.findOne(userId, dto.resumeId)
      : await this.resumesService.getPrimary(userId);

    const existing = await this.applications.findOne({ where: { userId, jobId: dto.jobId } });
    if (existing) {
      // An auto-apply batch that targets specific jobs may reuse an earlier (unsent / failed) application:
      // tag it with the batch so the batch can see, count and resume it.
      if (autoApplyBatchId && existing.autoApplyBatchId !== autoApplyBatchId) {
        await this.applications.update({ id: existing.id }, { autoApplyBatchId });
        existing.autoApplyBatchId = autoApplyBatchId;
      }
      return existing;
    }

    return this.applications.save(
      this.applications.create({
        userId,
        jobId: dto.jobId,
        resumeId: resume.id,
        status: 'PENDING',
        autoApplyBatchId,
      }),
    );
  }

  /**
   * The "just give us the job details" entry point: the user doesn't need a
   * pre-existing Job record (from search/browse) at all - they type in the
   * company name and job description (requirements optional), and we create
   * a lightweight manual Job record behind the scenes, wire it up to an
   * Application, and immediately generate the tailored resume + cover letter
   * for it. Requires the user to already have a resume on file (uploaded via
   * POST /resumes) so there's a profile to tailor from.
   */
  async generateForJobDetails(userId: string, dto: GenerateForJobDto) {
    const resume = dto.resumeId
      ? await this.resumesService.findOne(userId, dto.resumeId)
      : await this.resumesService.getPrimary(userId);

    const description = dto.requirements?.trim()
      ? `${dto.jobDescription.trim()}\n\nRequirements:\n${dto.requirements.trim()}`
      : dto.jobDescription.trim();

    // source: 'manual' + a unique synthetic applyUrl keeps this compatible
    // with the Job schema's required `applyUrl` and its
    // {source, externalId, applyUrl} uniqueness index, without implying this
    // job came from a real posting anywhere - it's just a vehicle for the
    // description text the user typed in. It's not meant to be auto-submitted
    // to; POST /applications/:id/apply will simply land on the generic
    // fallback and report back that there's nowhere real to submit to.
    const job = await this.jobs.save(
      this.jobs.create({
        source: 'manual',
        applyUrl: `manual://${randomUUID()}`,
        title: dto.jobTitle?.trim() || `Role at ${dto.company.trim()}`,
        company: dto.company.trim(),
        jobType: 'CUSTOM',
        description,
      }),
    );

    const application = await this.applications.save(
      this.applications.create({
        userId,
        jobId: job.id,
        resumeId: resume.id,
        status: 'PENDING',
      }),
    );

    return this.generateDocuments(userId, application.id);
  }

  /**
   * Fetches generated documents for an application with an explicit query
   * (rather than a has-many relation), so the response always has them.
   */
  private async getDocumentsFor(applicationId: string) {
    assertValidId(applicationId, 'Application');
    return this.documents.find({ where: { applicationId }, order: { createdAt: 'ASC' } });
  }

  /** Generates the tailored resume + cover letter for an application. */
  async generateDocuments(userId: string, applicationId: string) {
    const application = await this.getOwned(userId, applicationId);
    const resume = await this.resumesService.findOne(userId, String(application.resumeId));
    const job = await this.jobs.findOneBy({ id: application.jobId });
    if (!job) throw new NotFoundException('Job not found');

    await this.persist(application, { status: 'GENERATING' });

    try {
      const docs = await this.documentsService.generateApplicationDocuments(
        userId,
        applicationId,
        resume.parsedProfile as any,
        { id: job.id, title: job.title, company: job.company || 'the company', description: job.description },
      );

      // Also clear out any stale feedback from an earlier failed attempt - once
      // generation succeeds, an old "Document generation failed: ..."
      // message shouldn't keep showing next to documents that now exist.
      // (null, not undefined: that is what actually clears the column.)
      await this.persist(application, { status: 'READY', feedback: null });

      return docs;
    } catch (err) {
      await this.persist(application, {
        status: 'FAILED',
        feedback: `Document generation failed: ${(err as Error).message}`,
      });
      throw err;
    }
  }

  /**
   * Runs the full pipeline for one application: generate docs (if not already
   * done), then attempt auto-submission. Always ends with human-readable
   * feedback stored on the record, regardless of outcome.
   */
  async generateAndSubmit(userId: string, applicationId: string): Promise<Record<string, any>> {
    let application = await this.getOwned(userId, applicationId);
    let existingDocs = await this.getDocumentsFor(applicationId);
    let resumeDoc: any = existingDocs.find((d) => d.type === 'RESUME');
    let coverLetterDoc: any = existingDocs.find((d) => d.type === 'COVER_LETTER');

    // Only trust "documents already generated" when BOTH are actually
    // present - a stale READY status with missing documents (e.g. a
    // generation that never persisted, or a read-after-write race right
    // after a transaction commits) should regenerate, not crash later on
    // an undefined resumeDoc/coverLetterDoc.
    if (!resumeDoc || !coverLetterDoc) {
      const generated = await this.generateDocuments(userId, applicationId);
      resumeDoc = generated.resume;
      coverLetterDoc = generated.coverLetter;
      application = await this.getOwned(userId, applicationId);
    }

    const resume = await this.resumesService.findOne(userId, String(application.resumeId));
    const job = await this.jobs.findOneBy({ id: application.jobId });
    if (!job) throw new NotFoundException('Job not found');
    const profile = resume.parsedProfile as any;

    await this.persist(application, { status: 'SUBMITTING' });

    if (!resumeDoc?.filePath) {
      // Should be unreachable given the guard above, but fail loudly and
      // specifically instead of throwing a cryptic TypeError if it ever is.
      await this.persist(application, {
        status: 'FAILED',
        feedback: 'Could not find a generated resume file to submit. Please try generating documents again.',
      });
      return this.attachDocuments(application, applicationId);
    }

    const submitter = this.submitterRegistry.resolve(job.applyUrl);
    const applicant: any = application.user;

    // If the user has stored login credentials for this site's domain, pass
    // them along so the submitter can attempt to sign in (and, if opted in,
    // attempt a best-effort signup) before filling out the application.
    // Manually-entered jobs (see generateForJobDetails) have a synthetic
    // "manual://..." applyUrl with no real hostname to match against, so
    // this naturally resolves to no credentials for those.
    let credentials: DecryptedSiteCredential | null = null;
    try {
      const hostname = new URL(job.applyUrl).hostname;
      credentials = await this.credentialsService.findForDomain(userId, hostname);
    } catch {
      // Not a well-formed absolute URL - nothing to match a credential against.
    }

    let result;
    try {
      result = await submitter.submit(
        job.applyUrl,
        {
          fullName: profile?.fullName || `${applicant?.firstName ?? ''} ${applicant?.lastName ?? ''}`.trim(),
          email: profile?.email,
          phone: profile?.phone,
          linkedinUrl: undefined,
          portfolioUrl: undefined,
        },
        { resumePath: resumeDoc.filePath, coverLetterPath: coverLetterDoc?.filePath },
        credentials,
      );
    } catch (err) {
      this.logger.error(`Submission threw for application ${applicationId}: ${err}`);
      result = {
        outcome: 'FAILED' as const,
        message: `Unexpected error while attempting to apply: ${(err as Error).message}`,
      };
    }

    const statusMap: Record<string, ApplicationStatus> = {
      SUBMITTED: 'SUBMITTED',
      MANUAL_REVIEW: 'MANUAL_REVIEW',
      FAILED: 'FAILED',
    };

    await this.persist(application, {
      status: statusMap[result.outcome],
      feedback: this.buildFeedback(job.title, job.company ?? null, job.applyUrl, result),
      submittedAt: result.outcome === 'SUBMITTED' ? new Date() : null,
    });

    // Return with documents attached explicitly - the frontend uses this
    // response directly (no follow-up GET), so it needs the generated
    // documents present right away, not just a status flag.
    return this.attachDocuments(application, applicationId);
  }

  /**
   * Records the outcome of an application that the user's own browser submitted (via the Sherpa extension).
   * Nothing is submitted here - this only stores the result so it shows up in Applications and the dashboard.
   * An application that is already SUBMITTED is never downgraded by a later report.
   */
  async recordClientResult(userId: string, applicationId: string, dto: RecordResultDto): Promise<Record<string, any>> {
    const application = await this.getOwned(userId, applicationId);
    if (application.status === 'SUBMITTED' && dto.outcome !== 'SUBMITTED') {
      return this.attachDocuments(application, applicationId);
    }
    const job = application.job;
    if (!job) throw new NotFoundException('Job not found');
    await this.persist(application, {
      status: dto.outcome,
      feedback: this.buildFeedback(job.title, job.company ?? null, job.applyUrl, dto),
      submittedAt: dto.outcome === 'SUBMITTED' ? new Date() : null,
    });
    return this.attachDocuments(application, applicationId);
  }

  private buildFeedback(title: string, company: string | null, applyUrl: string, result: any) {
    const header = `${title} at ${company || 'the company'}: ${result.message}`;
    const details: string[] = [];
    if (result.fieldsFilled?.length) details.push(`Filled: ${result.fieldsFilled.join(', ')}`);
    if (result.fieldsMissing?.length) details.push(`Could not fill: ${result.fieldsMissing.join(', ')}`);
    // Nothing stays open anywhere for the candidate to come back to - the
    // form-filling attempt runs in a background browser on the server and
    // is already closed by the time this message is written. Always point
    // back to the real posting so "finish it manually" is actually
    // actionable instead of vague.
    if (result.outcome !== 'SUBMITTED') {
      details.push(`Finish it yourself here: ${applyUrl}`);
    }
    return [header, ...details].join('\n');
  }

  /** Writes `patch` to the row AND mirrors it onto the in-memory entity (explicit nulls clear columns). */
  private async persist(application: Application, patch: Partial<Application>) {
    await this.applications.update({ id: application.id }, patch as any);
    Object.assign(application, patch);
  }

  /** The application with its `job` and `user` loaded - used internally. Does NOT include `documents`. */
  async getOwned(userId: string, applicationId: string) {
    const application = await this.applications.findOne({
      where: ownedBy(applicationId, userId, 'Application'),
      relations: { job: true, user: true },
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  private async attachDocuments(application: Application, applicationId: string): Promise<Record<string, any>> {
    const documents = await this.getDocumentsFor(applicationId);
    const json: Record<string, any> = application.toJSON();
    if (json.user) json.user = stripUserSecrets(json.user);
    return { ...json, documents: documents.map((d) => d.toJSON()) };
  }

  /** Used by the controller - same as getOwned but with generated documents attached. */
  async getOwnedForResponse(userId: string, applicationId: string): Promise<Record<string, any>> {
    const application = await this.getOwned(userId, applicationId);
    return this.attachDocuments(application, applicationId);
  }

  async listForUser(userId: string): Promise<Record<string, any>[]> {
    assertValidId(userId, 'User');
    const applications = await this.applications.find({
      where: { userId },
      relations: { job: true },
      order: { createdAt: 'DESC' },
    });
    if (applications.length === 0) return [];

    const allDocs = await this.documents.find({
      where: { applicationId: In(applications.map((a) => a.id)) },
      order: { createdAt: 'ASC' },
    });

    const docsByApplication = new Map<string, any[]>();
    for (const doc of allDocs) {
      const key = String(doc.applicationId);
      const bucket = docsByApplication.get(key) || [];
      bucket.push(doc.toJSON());
      docsByApplication.set(key, bucket);
    }

    return applications.map((a) => ({ ...a.toJSON(), documents: docsByApplication.get(a.id) || [] }));
  }
}
