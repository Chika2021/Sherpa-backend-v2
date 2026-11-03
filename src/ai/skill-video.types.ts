/**
 * Types and small pure helpers for a course's "Tutorial videos" section.
 *
 * Kept free of Nest/Mongoose imports so the schema, the AI layer, the search
 * sources and the service can all share it without import cycles.
 */

/** Most videos one "find videos" request may ask for. */
export const MAX_VIDEOS_PER_REQUEST = 20;
/** Most videos one course may hold in total (bounds the size of its document). */
export const MAX_VIDEOS_PER_SKILL = 60;

/** A YouTube video id: exactly 11 URL-safe characters. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** A tutorial video saved on a course. `videoId` is its identity - the key used to delete it. */
export interface SkillVideo {
  videoId: string;
  /** Normal watch page, for the "open on YouTube" link. */
  url: string;
  /** Privacy-friendly embed URL the app plays in an iframe. */
  embedUrl: string;
  title: string;
  channel: string;
  thumbnailUrl: string;
  description?: string;
  durationSeconds?: number;
  views?: number;
  /** ISO date the video was published, when the source knows it. */
  publishedAt?: string;
  /** Where the AI places it on the course's beginner -> advanced arc. */
  level?: string;
  /** One line from the AI on why this video is worth watching for this course. */
  why?: string;
  addedAt: string;
}

/** A real, verified video found by a search source, before the AI curates the final list. */
export interface VideoCandidate {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string;
  description?: string;
  durationSeconds?: number;
  views?: number;
  publishedAt?: string;
  /** How many of the search queries surfaced it - a cheap relevance signal. */
  queryHits?: number;
}

/** What the AI is told about the course when planning searches and curating results. */
export interface VideoSearchContext {
  title: string;
  level: string;
  modules: Array<{ tier: string; heading: string }>;
}

/** One of the AI's picks from the candidate list. */
export interface VideoPick {
  videoId: string;
  level?: string;
  why?: string;
}

export const videoWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const videoEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}`;
export const thumbnailFor = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);

/**
 * Pulls the video id out of any common YouTube link shape (watch, youtu.be,
 * embed, shorts, live) or a bare 11-character id. Returns null for anything
 * that isn't one - which is how links invented by a model get dropped early.
 */
export function extractYouTubeId(input: string | undefined | null): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (YOUTUBE_ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let candidate: string | null | undefined;
  if (host === 'youtu.be') candidate = url.pathname.split('/')[1];
  else if (url.pathname === '/watch') candidate = url.searchParams.get('v');
  else {
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    candidate = m?.[1];
  }
  return candidate && YOUTUBE_ID_RE.test(candidate) ? candidate : null;
}

/** ISO-8601 duration from the YouTube API ("PT1H2M3S") to seconds. */
export function parseIsoDuration(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  const seconds = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** 3723 -> "1:02:03", 185 -> "3:05". */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** YouTube search results can carry HTML entities in titles ("Tom &amp; Jerry", "don&#39;t"). */
export function decodeEntities(text: string | undefined | null): string {
  return (text ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Super Advanced'];

/** Normalises whatever level the AI wrote to one of the course tiers, or undefined if it isn't one. */
export function normalizeLevel(raw: unknown): string | undefined {
  const text = String(raw ?? '').trim().toLowerCase();
  return LEVELS.find((l) => l.toLowerCase() === text);
}
