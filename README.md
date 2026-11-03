# Job Apply Backend (NestJS)

An AI-powered backend that lets a user register, upload a resume, discover
matching jobs (online / remote / freelance / full-time / anything they type),
generate a tailored resume + cover letter per job, and either apply one job at
a time or hand it a number and let **Auto Apply** work through a batch in the
background — always reporting back exactly what it did.

## Read this first: what "auto apply" actually does

Two things are worth being upfront about, because they shape how you should
use this:

1. **Job discovery** uses Gemini with Google Search grounding (`GeminiService.discoverJobs`).
   It genuinely searches the live web and returns real postings with citations —
   it isn't just recalling stale training data. But it's not a dedicated job-board
   API, so treat `applyUrl`s as "found by AI, worth verifying" rather than
   guaranteed-canonical. For production-grade coverage, plug in a real job API
   (Adzuna, JSearch/RapidAPI, or a specific ATS's public board API) as a second
   `JobSourceProvider` (see `src/jobs/providers/job-source.interface.ts`) and use
   Gemini as the ranker/matcher on top — the architecture already supports this.

2. **Auto-submission** uses a headless-browser form-filler (`GenericFormAdapter`,
   Playwright) that recognizes common field patterns (name, email, phone,
   resume upload, LinkedIn, etc.) across most standard application pages. It is
   deliberately conservative: if it can't confidently fill every required field
   (name, email, resume upload) or can't find a submit button, it stops and
   marks the application `MANUAL_REVIEW` with a screenshot and a list of what
   it filled vs. couldn't — instead of guessing and silently submitting a
   broken application. Pages behind logins, CAPTCHAs, or heavily custom
   multi-step wizards will usually land here. This is a feature, not a missing
   feature: a trustworthy auto-apply tool tells you when it needs help.

So: every application in a batch ends in one of `SUBMITTED`, `MANUAL_REVIEW`,
or `FAILED`, each with human-readable feedback — that's the "feedback and
detail of the jobs it applied for you" the batch status endpoint returns.

## Architecture

```
src/
  auth/            register, login, JWT strategy/guard
  users/           profile (name, phone, LinkedIn, portfolio, etc.)
  resumes/         upload (PDF/DOCX/TXT) -> text extraction -> Gemini structured parse
  ai/               GeminiService: resume parsing, job discovery (Search grounding),
                    tailored resume generation, cover letter generation
  jobs/            AI-powered job search, persisted Job + JobSearch records,
                    save/unsave jobs; pluggable JobSourceProvider interface
  documents/       turns generated resume/cover-letter text into .docx files
  applications/    ties a user + job + resume into an Application; generates
                    documents; submits via adapters/ (GenericFormAdapter today,
                    extensible to ATS-specific API adapters)
  auto-apply/      takes {count, filters}, queues a Bull job, and works through
                    up to `count` matching jobs end-to-end, tracking live
                    succeeded/manual-review/failed counts on the batch
  database/        TypeORM connection to Supabase Postgres (DATABASE_URL), helpers
  entities/        TypeORM entities - the data model (one file per table)
  storage/         disk storage for uploads + generated documents
  common/          JWT guard, current-user decorator, global exception filter
entities/             full data model (User, Resume, Job, JobSearch,
                       Application, GeneratedDocument, AutoApplyBatch, ...)
```

## Setup

```bash
npm install
npx playwright install chromium   # for the form-fill adapter

cp .env.example .env
# fill in DATABASE_URL, JWT_SECRET, GEMINI_API_KEY (https://aistudio.google.com/app/apikey)

npm run db:sync      # creates/updates the Postgres tables (see POSTGRES_MIGRATION.md)
npm run start:dev
```

You'll also need:
- **A Supabase (Postgres) database.** Copy the connection string from
  Supabase -> Project Settings -> Database -> Connection string (URI) into
  `DATABASE_URL`. No replica set or special setup is needed - Postgres supports
  transactions natively. See `POSTGRES_MIGRATION.md`.
- **Redis** running, for the Auto Apply background queue (Bull).

Schema changes are applied with `npm run db:sync` (or, for a production
database, TypeORM migrations - see `POSTGRES_MIGRATION.md`).

## API walkthrough

All routes are under `/api/v1`. Protected routes need `Authorization: Bearer <accessToken>`.

**1. Register / login**
```
POST /auth/register   { email, password, firstName?, lastName? }
POST /auth/login       { email, password }
```
Both return `{ accessToken, user }`.

**2. Upload a resume** (multipart, field name `file`, PDF/DOCX/TXT)
```
POST /resumes
```
Extracts text and asks Gemini to parse it into a structured profile
(skills, experience, education, etc.) stored on the resume.

**3. Search for jobs** — pick a category, type your own query, or both
```
POST /jobs/search
{
  "jobTypes": ["REMOTE", "FREELANCE"],      // or FULL_TIME, PART_TIME, ONLINE, CONTRACT, INTERNSHIP
  "query": "senior backend engineer",        // or leave blank to let AI infer from your resume
  "location": "anywhere",
  "limit": 10
}
```
Returns real postings ranked by fit, each with a `matchScore` and `matchReason`.

**4. Apply to one job, fully hands-off**
```
POST /applications                    { "jobId": "..." }
POST /applications/:id/apply          -> generates tailored resume + cover
                                          letter, attempts auto-submit, and
                                          returns status + feedback
```
Or split the steps: `POST /applications/:id/generate-documents` first if you
want to review the tailored resume/cover letter before submitting.

**5. Auto Apply to N jobs**
```
POST /auto-apply
{
  "count": 15,
  "jobTypes": ["REMOTE"],
  "query": "product designer"
}
```
Returns the batch immediately (`status: QUEUED`); it then runs in the
background. Poll:
```
GET /auto-apply/:id
```
for live `succeededCount` / `manualReviewCount` / `failedCount`, plus every
`Application` in the batch with its job details and feedback message.

## Notes on extending this

- Add real job-board sources by implementing `JobSourceProvider` and merging
  their results with Gemini's in `JobsService.search`.
- Add ATS-specific submission adapters (if you get API access to a company's
  Greenhouse/Lever/Workable board) by implementing `ApplicationSubmitter` and
  registering it before `GenericFormAdapter` in `SubmitterRegistry` — check
  each ATS's current developer docs for their exact apply-submission contract,
  since it varies per board and changes over time.
- Swap `.docx` generation for PDF in `DocumentsService` if you'd rather store
  PDFs (the `pdf-lib` dependency is already included).
