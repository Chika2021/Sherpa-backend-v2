import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { GeminiService } from '../ai/gemini.service';
import {
  MAX_VIDEOS_PER_REQUEST,
  MAX_VIDEOS_PER_SKILL,
  SkillVideo,
  VideoCandidate,
  VideoSearchContext,
  YOUTUBE_ID_RE,
  videoEmbedUrl,
  videoWatchUrl,
} from '../ai/skill-video.types';
import { SkillTutorial } from '../entities/skill-tutorial.entity';
import { ownedBy } from '../database/db-utils';
import { updateLockedRow } from '../database/locked-row.util';
import { HttpFetch, VideoSearchSource, WebSearchSource, YouTubeApiError, YouTubeApiSource } from './video-search.sources';

/** Billing label - one AI token per search, however many model calls it takes (see FEATURE_TOKEN_COSTS). */
const LABEL = 'findSkillVideos';
/** Search rounds: a second round (with fresh queries) only runs if the first found too few candidates to choose from. */
const MAX_ROUNDS = 2;

/**
 * Newest batch first. Videos are stored oldest -> newest (atomic row-locked append), so the
 * list is sorted for display by when each was added. Videos added by the same
 * search share one timestamp and the sort is stable, so within a batch the
 * beginner -> advanced learning-path order the AI chose is kept.
 */
function newestFirst(videos: SkillVideo[]): SkillVideo[] {
  const time = (v: SkillVideo) => (v.addedAt ? Date.parse(v.addedAt) || 0 : 0);
  return [...videos].sort((a, b) => time(b) - time(a));
}

export interface FindVideosResult {
  /** Videos added by this request. */
  added: SkillVideo[];
  /** Every video on the course now, in order. */
  videos: SkillVideo[];
  requested: number;
  /** How many were actually added - can be fewer than requested when not enough good videos exist. */
  found: number;
  source: string;
  note?: string;
  /** Human-readable line saying which search engine produced these videos (shown by the app if it wants). */
  message: string;
}

@Injectable()
export class SkillVideosService implements OnModuleInit {
  private readonly logger = new Logger(SkillVideosService.name);
  // One search at a time per course: a double-click must not run (and bill) two searches or add duplicates.
  private readonly searching = new Set<string>();

  constructor(
    @InjectRepository(SkillTutorial) private tutorials: Repository<SkillTutorial>,
    @InjectDataSource() private dataSource: DataSource,
    private gemini: GeminiService,
    private config: ConfigService,
  ) {}

  /** Startup line: tells you right away whether video search will use the YouTube API. */
  onModuleInit() {
    if (this.youtubeKey()) {
      this.logger.log('[YouTube API] ENABLED - video search uses the YouTube Data API first (Gemini is only used afterwards to pick the best videos).');
    } else {
      this.logger.warn('[YouTube API] DISABLED - YOUTUBE_API_KEY is not set, so video search will use Gemini web search instead.');
    }
  }

  /** The HTTP client for the search sources. Overridable so tests never touch the network. */
  protected http(): HttpFetch {
    return (url, init) => fetch(url, init);
  }

  private youtubeKey(): string | undefined {
    const key = this.config.get<string>('YOUTUBE_API_KEY')?.trim();
    return key || undefined;
  }

  private async load(userId: string, id: string) {
    // `videos` is a `select: false` column, so it is added explicitly.
    const record = await this.tutorials
      .createQueryBuilder('t')
      .addSelect('t.videos')
      .where('t.id = :id AND t.userId = :userId', ownedBy(id, userId, 'Skill tutorial'))
      .getOne();
    if (!record) throw new NotFoundException('Skill tutorial not found');
    return record;
  }

  async list(userId: string, id: string) {
    const record = await this.load(userId, id);
    const videos = newestFirst((record.videos ?? []) as SkillVideo[]);
    return { videos, count: videos.length, maxPerRequest: MAX_VIDEOS_PER_REQUEST, maxPerCourse: MAX_VIDEOS_PER_SKILL };
  }

  /**
   * Finds `count` tutorial videos for the course on the internet, adds them,
   * and returns them. Nothing is added or billed unless at least one suitable,
   * verified, embeddable video was found.
   */
  async find(userId: string, id: string, rawCount: number): Promise<FindVideosResult> {
    const requested = Math.min(MAX_VIDEOS_PER_REQUEST, Math.max(1, Math.floor(Number(rawCount) || 0)));
    if (this.searching.has(id)) throw new ConflictException('Videos are already being searched for this course. Please wait for that to finish.');
    this.searching.add(id);
    try {
      const record = await this.load(userId, id);
      const existing = (record.videos ?? []) as SkillVideo[];

      const room = MAX_VIDEOS_PER_SKILL - existing.length;
      if (room <= 0) {
        throw new BadRequestException(`This course already has the maximum of ${MAX_VIDEOS_PER_SKILL} videos. Delete some to add more.`);
      }
      const want = Math.min(requested, room);

      await this.gemini.assertCanAffordFeature(userId, LABEL);

      const ctx: VideoSearchContext = {
        title: record.title,
        level: record.level,
        modules: (record.modules ?? []).map((m) => ({ tier: m.tier, heading: m.heading })),
      };
      const exclude = new Set(existing.map((v) => v.videoId));

      const { pool, source, sources } = await this.gather(userId, ctx, want, exclude);
      if (!pool.size) {
        throw new NotFoundException('No embeddable tutorial videos could be found for this course right now. Please try again in a moment.');
      }

      const picks = await this.gemini.curateVideoCandidates(userId, ctx, [...pool.values()], want);
      const now = new Date().toISOString();
      const added: SkillVideo[] = [];
      for (const pick of picks) {
        const c = pool.get(pick.videoId);
        if (!c || added.some((v) => v.videoId === c.videoId)) continue;
        added.push(this.toSkillVideo(c, pick.level, pick.why, now));
      }
      if (!added.length) {
        throw new NotFoundException('The AI could not find tutorial videos good enough to add for this course. Please try again.');
      }

      // Atomic append: concurrent changes to the course (deleting a video, etc.) are never overwritten.
      await updateLockedRow<{ videos: SkillVideo[] | null }>(
        this.dataSource,
        SkillTutorial,
        { id, userId },
        ['videos'],
        (row) => ({ videos: [...(row.videos ?? []), ...added] }),
      );
      await this.gemini.chargeFeature(userId, LABEL);

      const note =
        added.length < requested
          ? added.length < want
            ? `Found ${added.length} suitable video${added.length === 1 ? '' : 's'} (you asked for ${requested}). Only videos that are good, embeddable tutorials for this course are added.`
            : `Added ${added.length} of the ${requested} you asked for - the course holds at most ${MAX_VIDEOS_PER_SKILL} videos.`
          : undefined;

      const message = sources.has('youtube-api')
        ? `Tutorial vidoes found${sources.has('web-search') ? ' (plus Gemini web search)' : ''}.`
        : 'The YouTube API was not available, so these videos were found using Gemini web search.';
      this.logger.log(`[Videos] Search complete: ${added.length} video(s) added via ${[...sources].join(' + ') || 'none'}.`);

      return { added, videos: newestFirst([...existing, ...added]), requested, found: added.length, source, note, message };
    } finally {
      this.searching.delete(id);
    }
  }

  /**
   * YouTube first, Gemini second. The first round's queries are built locally
   * from the course (no AI call) and go straight to the YouTube API, so Gemini's
   * quota is never touched just to start a search. Gemini is only asked for fresh
   * queries if a second round is needed and the local ones are used up; it is
   * otherwise used afterwards, to curate the verified results (and as the
   * web-search fallback if the YouTube key is unusable - see search()).
   */
  private async gather(userId: string, ctx: VideoSearchContext, want: number, exclude: Set<string>) {
    const pool = new Map<string, VideoCandidate>();
    const usedQueries: string[] = [];
    const localQueries = this.localQueries(ctx, want);
    let source = 'none';
    const sources = new Set<string>();

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const fresh = (qs: string[]) => qs.filter((q) => !usedQueries.some((u) => u.toLowerCase() === q.toLowerCase()));
      const perRound = Math.min(6, 3 + Math.ceil(want / 6));
      let queries = fresh(localQueries).slice(0, perRound);
      if (!queries.length) {
        // Local queries exhausted and the pool is still thin: only now ask Gemini (it falls back to plain queries itself if it is out of quota).
        queries = fresh(await this.gemini.planVideoSearchQueries(userId, ctx, want, usedQueries));
      }
      if (!queries.length) break;
      usedQueries.push(...queries);

      const result = await this.search(userId, ctx, want, queries);
      source = result.source;
      sources.add(result.source);
      for (const c of result.candidates) {
        if (exclude.has(c.videoId)) continue;
        const prior = pool.get(c.videoId);
        if (prior) prior.queryHits = (prior.queryHits ?? 1) + (c.queryHits ?? 1);
        else pool.set(c.videoId, c);
      }
      // Enough raw material for the AI to choose well from: stop early.
      if (pool.size >= want * 2) break;
    }
    return { pool, source, sources };
  }

  /**
   * Search queries built from the course itself - the broad ones first, then
   * one per important module - written the way a person would type them into
   * YouTube. No AI involved.
   */
  private localQueries(ctx: VideoSearchContext, want: number): string[] {
    const title = ctx.title.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
    const queries = [`${title} full course`, `${title} tutorial for beginners`, `${title} crash course`, `${title} advanced tutorial`];
    // One query per module heading, spread across the beginner -> advanced arc.
    const headings = ctx.modules.map((m) => m.heading.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const wantHeadings = Math.min(headings.length, Math.max(4, Math.ceil(want / 2)));
    const step = headings.length / Math.max(1, wantHeadings);
    for (let i = 0; i < wantHeadings; i++) {
      const h = headings[Math.floor(i * step)];
      queries.push(`${title} ${h}`.slice(0, 120));
    }
    const seen = new Set<string>();
    return queries.filter((q) => q.length >= 3 && (seen.has(q.toLowerCase()) ? false : (seen.add(q.toLowerCase()), true)));
  }

  /** YouTube's API first when a key is set; Gemini web search only if the key is rejected / out of quota, or no key is set. */
  private async search(userId: string, ctx: VideoSearchContext, want: number, queries: string[]) {
    const http = this.http();
    const webSearch = new WebSearchSource((q) => this.gemini.findVideoIdsWithWebSearch(userId, ctx, want, q), http);

    const key = this.youtubeKey();
    if (key) {
      const api: VideoSearchSource = new YouTubeApiSource(key, http);
      try {
        const started = Date.now();
        this.logger.log(`[YouTube API] RUNNING - searching YouTube with ${queries.length} queries (about ${queries.length * 100} quota units): ${queries.join(' | ')}`);
        const candidates = await api.search(queries);
        this.logger.log(`[YouTube API] OK - returned ${candidates.length} verified, embeddable videos in ${Date.now() - started}ms.`);
        return { candidates, source: api.name };
      } catch (err) {
        if (!(err instanceof YouTubeApiError) || !err.fatal) throw err;
        this.logger.warn(`[YouTube API] FAILED - unusable (${err.status} ${err.reason}: ${err.message}) - falling back to web search.`);
      }
    }

    try {
      return { candidates: await webSearch.search(queries), source: webSearch.name };
    } catch (err) {
      this.logger.error(`Video web search failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        key
          ? 'Video search is temporarily unavailable (the YouTube API key was rejected and the web-search fallback failed). Please try again later.'
          : 'Video search is temporarily unavailable. Please try again later. (Setting YOUTUBE_API_KEY makes it much more reliable.)',
      );
    }
  }

  private toSkillVideo(c: VideoCandidate, level: string | undefined, why: string | undefined, addedAt: string): SkillVideo {
    return {
      videoId: c.videoId,
      url: videoWatchUrl(c.videoId),
      embedUrl: videoEmbedUrl(c.videoId),
      title: c.title,
      channel: c.channel,
      thumbnailUrl: c.thumbnailUrl,
      description: c.description || undefined,
      durationSeconds: c.durationSeconds,
      views: c.views,
      publishedAt: c.publishedAt,
      level,
      why,
      addedAt,
    };
  }

  /** Removes one video from the course. */
  async remove(userId: string, id: string, videoId: string) {
    ownedBy(id, userId, 'Skill tutorial'); // validates both ids
    if (!YOUTUBE_ID_RE.test(videoId)) throw new BadRequestException('That is not a valid video id.');
    let removedOne = false;
    const res = await updateLockedRow<{ videos: SkillVideo[] | null }>(
      this.dataSource,
      SkillTutorial,
      { id, userId },
      ['videos'],
      (row) => {
        const current = row.videos ?? [];
        const next = current.filter((v) => v.videoId !== videoId);
        if (next.length === current.length) return null;
        removedOne = true;
        return { videos: next };
      },
    );
    if (!res.matched) throw new NotFoundException('Skill tutorial not found');
    if (!removedOne) throw new NotFoundException('That video is not on this course.');
    return { deleted: true, videoId };
  }

  /** Removes every video from the course. */
  async removeAll(userId: string, id: string) {
    ownedBy(id, userId, 'Skill tutorial'); // validates both ids
    let removed = 0;
    const res = await updateLockedRow<{ videos: SkillVideo[] | null }>(
      this.dataSource,
      SkillTutorial,
      { id, userId },
      ['videos'],
      (row) => {
        removed = (row.videos ?? []).length;
        return { videos: [] };
      },
    );
    if (!res.matched) throw new NotFoundException('Skill tutorial not found');
    return { deleted: true, removed };
  }
}