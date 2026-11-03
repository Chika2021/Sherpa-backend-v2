import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../ai/gemini.service';
import { JobSourceCriteria, JobSourceProvider, RawJobListing } from '../jobs/providers/job-source.interface';
import { fetchJsonWithRetry } from '../jobs/providers/fetch-with-diagnostics';

type Ats = 'greenhouse' | 'lever' | 'ashby';

interface BoardRef {
  ats: Ats;
  token: string;
}

const CACHE_TTL_MS = 20 * 60_000;
// Company boards are a bonus source: fail fast instead of stalling the whole search.
const ATS_TIMEOUT_MS = 5_000;
// A board that errors (wrong token, blocked host) is not retried for this long.
const FAILURE_BACKOFF_MS = 30 * 60_000;

/**
 * Reads the OFFICIAL public job-board JSON endpoints that Greenhouse, Lever
 * and Ashby expose for any company that uses them. No scraping and no API
 * keys are involved, so it is the most stable way to add a new AI-training
 * employer: find their careers page, look at the board URL, add its token.
 *
 *   boards.greenhouse.io/<token>      -> greenhouse:<token>
 *   jobs.lever.co/<token>             -> lever:<token>
 *   jobs.ashbyhq.com/<token>          -> ashby:<token>
 *
 * Configure with a comma-separated env var, e.g.
 *   AI_TRAINING_BOARDS=greenhouse:examplecorp,lever:anotherco,ashby:thirdco
 *
 * Nothing is enabled by default: I could not verify any company's board
 * token from the build environment, and a wrong token just returns 404.
 * Boards that 404 are logged once and skipped, never failing a search.
 */
@Injectable()
export class AtsBoardProvider implements JobSourceProvider {
  readonly name = 'ats-boards';
  private readonly logger = new Logger(AtsBoardProvider.name);
  private readonly boards: BoardRef[];
  private cache = new Map<string, { at: number; jobs: RawJobListing[] }>();

  constructor(config: ConfigService) {
    this.boards = parseBoards(config.get<string>('AI_TRAINING_BOARDS') || '');
    if (!this.boards.length) {
      this.logger.log('AI_TRAINING_BOARDS is empty - only public remote-job feeds will be searched.');
    }
  }

  async search(_profile: ResumeProfile, _criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const results = await Promise.all(this.boards.map((b) => this.getBoard(b)));
    return results.flat();
  }

  private async getBoard(b: BoardRef): Promise<RawJobListing[]> {
    const key = `${b.ats}:${b.token}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.jobs;
    try {
      const jobs = await this.fetchBoard(b);
      this.cache.set(key, { at: Date.now(), jobs });
      return jobs;
    } catch (err) {
      this.logger.warn(`${key}: ${(err as Error).message}`);
      // Remember the failure so a bad token / blocked host isn't re-tried (and waited on) every search.
      this.cache.set(key, { at: Date.now() - CACHE_TTL_MS + FAILURE_BACKOFF_MS, jobs: hit?.jobs ?? [] });
      return hit?.jobs ?? [];
    }
  }

  private async fetchBoard(b: BoardRef): Promise<RawJobListing[]> {
    switch (b.ats) {
      case 'greenhouse': {
        const body = await fetchJsonWithRetry<{ jobs?: any[] }>(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs?content=true`,
          { label: `Greenhouse(${b.token})`, timeoutMs: ATS_TIMEOUT_MS, retries: 0 },
        );
        return (body.jobs || []).map((j) => ({
          source: `greenhouse:${b.token}`,
          externalId: String(j.id),
          title: j.title,
          company: j.company_name || b.token,
          location: j.location?.name,
          jobType: 'CONTRACT',
          description: clean(decodeEntities(j.content || '')),
          applyUrl: j.absolute_url,
          isRemote: /remote/i.test(j.location?.name || ''),
          postedAt: j.first_published || j.updated_at ? new Date(j.first_published || j.updated_at) : undefined,
        }));
      }
      case 'lever': {
        const body = await fetchJsonWithRetry<any[]>(
          `https://api.lever.co/v0/postings/${encodeURIComponent(b.token)}?mode=json`,
          { label: `Lever(${b.token})`, timeoutMs: ATS_TIMEOUT_MS, retries: 0 },
        );
        return (Array.isArray(body) ? body : []).map((j) => ({
          source: `lever:${b.token}`,
          externalId: String(j.id),
          title: j.text,
          company: b.token,
          location: j.categories?.location,
          jobType: normalizeType(j.categories?.commitment),
          description: clean(j.descriptionPlain || ''),
          applyUrl: j.hostedUrl || j.applyUrl,
          isRemote: j.workplaceType === 'remote' || /remote/i.test(j.categories?.location || ''),
          postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
        }));
      }
      case 'ashby': {
        const body = await fetchJsonWithRetry<{ jobs?: any[] }>(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}?includeCompensation=true`,
          { label: `Ashby(${b.token})`, timeoutMs: ATS_TIMEOUT_MS, retries: 0 },
        );
        return (body.jobs || [])
          .filter((j) => j.isListed !== false)
          .map((j) => ({
            source: `ashby:${b.token}`,
            externalId: String(j.id),
            title: j.title,
            company: b.token,
            location: j.location,
            jobType: normalizeType(j.employmentType),
            description: clean(j.descriptionPlain || ''),
            applyUrl: j.jobUrl || j.applyUrl,
            isRemote: j.isRemote === true,
            salary: j.compensation?.compensationTierSummary,
            postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
          }));
      }
      default:
        return [];
    }
  }
}

function parseBoards(raw: string): BoardRef[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [ats, token] = s.split(':');
      return { ats: (ats || '').toLowerCase() as Ats, token: (token || '').trim() };
    })
    .filter((b) => ['greenhouse', 'lever', 'ashby'].includes(b.ats) && b.token);
}

function normalizeType(v?: string): string {
  const s = (v || '').toLowerCase();
  if (s.includes('intern')) return 'INTERNSHIP';
  if (s.includes('part')) return 'PART_TIME';
  if (s.includes('full')) return 'FULL_TIME';
  if (s.includes('freelance')) return 'FREELANCE';
  return 'CONTRACT';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function clean(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
