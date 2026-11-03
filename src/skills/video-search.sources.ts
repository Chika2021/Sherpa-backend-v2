import {
  VideoCandidate,
  YOUTUBE_ID_RE,
  decodeEntities,
  parseIsoDuration,
  thumbnailFor,
  videoWatchUrl,
} from '../ai/skill-video.types';

/**
 * Where real videos come from. Both sources return ONLY videos that were
 * confirmed to exist and be embeddable - the AI later curates from this list
 * and can never add a video that isn't on it, so nothing it "remembers" or
 * invents can reach a learner.
 */
export interface VideoSearchSource {
  readonly name: string;
  search(queries: string[]): Promise<VideoCandidate[]>;
}

/** The slice of `fetch` these sources use - lets tests pass a fake. */
export type HttpFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const API_BASE = 'https://www.googleapis.com/youtube/v3';
// Shorts, trailers and clips aren't tutorials; very long "full course" streams still are.
const MIN_SECONDS = 180;
const MAX_SECONDS = 12 * 3600;

/** A YouTube API failure. `fatal` means "this source won't work for any query" (bad/blocked key, quota) - not a one-off hiccup. */
export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

async function getJson(http: HttpFetch, url: string, timeoutMs = 10_000): Promise<{ ok: boolean; status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http(url, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Runs `worker` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

function toApiError(status: number, body: any): YouTubeApiError {
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? 'unknown');
  const message = String(body?.error?.message ?? `YouTube API returned HTTP ${status}`);
  // 400/401/403 on a search means the key itself is unusable (invalid, restricted, quota spent), not that one query was bad.
  return new YouTubeApiError(message, status, reason, status === 400 || status === 401 || status === 403);
}

/**
 * The reliable source: YouTube's own Data API (https://developers.google.com/youtube/v3).
 * Needs a free API key (YOUTUBE_API_KEY). Each search query costs 100 of the
 * default 10,000 daily quota units; the details lookup costs 1 per 50 videos.
 */
export class YouTubeApiSource implements VideoSearchSource {
  readonly name = 'youtube-api';

  constructor(
    private readonly apiKey: string,
    private readonly http: HttpFetch,
  ) {}

  async search(queries: string[]): Promise<VideoCandidate[]> {
    const found = new Map<string, { hits: number }>();
    let failures = 0;
    let lastError: YouTubeApiError | undefined;

    // A few at a time: polite to the API and plenty fast.
    for (const batch of chunk(queries, 3)) {
      await Promise.all(
        batch.map(async (q) => {
          const params = new URLSearchParams({
            part: 'snippet',
            type: 'video',
            q,
            maxResults: '15',
            videoEmbeddable: 'true',
            videoSyndicated: 'true',
            safeSearch: 'moderate',
            relevanceLanguage: 'en',
            key: this.apiKey,
          });
          const res = await getJson(this.http, `${API_BASE}/search?${params}`).catch(() => null);
          if (!res) {
            failures++;
            return;
          }
          if (!res.ok) {
            const err = toApiError(res.status, res.body);
            if (err.fatal) throw err;
            failures++;
            lastError = err;
            return;
          }
          for (const item of res.body?.items ?? []) {
            const id = item?.id?.videoId;
            if (typeof id !== 'string' || !YOUTUBE_ID_RE.test(id)) continue;
            const entry = found.get(id);
            if (entry) entry.hits++;
            else found.set(id, { hits: 1 });
          }
        }),
      );
    }

    if (!found.size) {
      if (failures === queries.length && lastError) throw lastError;
      return [];
    }

    // Search results don't say whether a video is embeddable/public or how long it is - the details call does.
    const details = new Map<string, any>();
    for (const ids of chunk([...found.keys()], 50)) {
      const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics,status', id: ids.join(','), key: this.apiKey });
      const res = await getJson(this.http, `${API_BASE}/videos?${params}`).catch(() => null);
      if (!res) continue;
      if (!res.ok) {
        const err = toApiError(res.status, res.body);
        if (err.fatal) throw err;
        continue;
      }
      for (const item of res.body?.items ?? []) if (item?.id) details.set(item.id, item);
    }

    const out: VideoCandidate[] = [];
    for (const [id, { hits }] of found) {
      const d = details.get(id); // missing = deleted/private since the search
      if (!d) continue;
      if (d.status?.embeddable === false) continue;
      if (d.status?.privacyStatus && d.status.privacyStatus !== 'public') continue;
      if (d.snippet?.liveBroadcastContent && d.snippet.liveBroadcastContent !== 'none') continue;
      const seconds = parseIsoDuration(d.contentDetails?.duration);
      if (seconds === undefined || seconds < MIN_SECONDS || seconds > MAX_SECONDS) continue;

      const thumbs = d.snippet?.thumbnails ?? {};
      out.push({
        videoId: id,
        title: decodeEntities(d.snippet?.title) || 'Untitled video',
        channel: decodeEntities(d.snippet?.channelTitle) || 'YouTube',
        thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbnailFor(id),
        description: decodeEntities(d.snippet?.description).slice(0, 400),
        durationSeconds: seconds,
        views: Number(d.statistics?.viewCount) || undefined,
        publishedAt: d.snippet?.publishedAt,
        queryHits: hits,
      });
    }
    return out;
  }
}

/**
 * Confirms a video really exists and can be embedded, using YouTube's public
 * oEmbed endpoint (no key needed): 200 = real and embeddable, 404 = missing or
 * private, 401 = embedding disabled. Also yields its true title and channel.
 */
export async function verifyWithOEmbed(id: string, http: HttpFetch): Promise<VideoCandidate | null> {
  if (!YOUTUBE_ID_RE.test(id)) return null;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoWatchUrl(id))}&format=json`;
  const res = await getJson(http, url, 8_000).catch(() => null);
  if (!res || !res.ok || typeof res.body?.title !== 'string') return null;
  return {
    videoId: id,
    title: decodeEntities(res.body.title),
    channel: decodeEntities(res.body.author_name) || 'YouTube',
    thumbnailUrl: thumbnailFor(id),
  };
}

/**
 * The key-less fallback: asks a web-search-grounded model for YouTube links,
 * then trusts none of them until each one passes `verifyWithOEmbed`. A model
 * that guessed or invented an id simply gets filtered out here. Less metadata
 * than the API (no duration/views), and the grounded model has a smaller
 * quota - which is why the API source is preferred whenever a key exists.
 */
export class WebSearchSource implements VideoSearchSource {
  readonly name = 'web-search';

  constructor(
    private readonly findVideoIds: (queries: string[]) => Promise<string[]>,
    private readonly http: HttpFetch,
  ) {}

  async search(queries: string[]): Promise<VideoCandidate[]> {
    const ids = [...new Set(await this.findVideoIds(queries))].slice(0, 60);
    const verified = await mapLimit(ids, 5, (id) => verifyWithOEmbed(id, this.http));
    return verified.filter((v): v is VideoCandidate => !!v);
  }
}
