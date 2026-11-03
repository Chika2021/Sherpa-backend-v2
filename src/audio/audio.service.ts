import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { GeminiService } from '../ai/gemini.service';
import type { AudioRefType } from './audio.types';
import { AudioChunkStore, ChunkRef } from './audio-chunk-store';
import { stripMarkdownForSpeech } from '../common/tts-text.util';

/**
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Gemini's free TTS tier is tiny (on the order of 3 requests/minute and a few
 * dozen requests/DAY - check AI Studio for your project's exact numbers). Every
 * Gemini call here is one ~4,500 character chunk, so the number of CALLS is
 * what has to be minimised. The previous design leaked calls in four ways:
 *
 *   1. Anything over ~3,500 characters never fit in one 16MB Mongo document,
 *      so long materials were NEVER cached and were re-synthesized on every
 *      single play.
 *   2. Chunks were generated as fast as Gemini answered, regardless of whether
 *      anyone was listening (a browser happily buffers a whole stream), so a
 *      listener who played 30 seconds still triggered the whole lesson.
 *   3. A listener who left halfway threw away every chunk already paid for.
 *   4. Two near-simultaneous requests for the same audio (browsers often send
 *      two) each paid for it.
 *
 * What it does now:
 *
 *   - CHUNK CACHE: every chunk is stored once in a small size-capped on-disk cache (never the database; AUDIO_CACHE=none turns caching off),
 *     content-addressed by sha256(voice + chunk text). A chunk is only ever
 *     synthesized once - per voice, for everyone, forever - and is kept even if
 *     the listener left while it was being generated. Replays, resumed
 *     listens, and other audio containing identical text are free.
 *   - LISTENER-PACED GENERATION: the next uncached chunk is only requested when
 *     the listener is within AUDIO_LEAD_SECONDS of running out of audio, and
 *     writes honour TCP back-pressure (a paused player stalls generation). You
 *     pay for what is actually listened to.
 *   - IN-FLIGHT DE-DUPLICATION: concurrent requests for the same chunk share
 *     one Gemini call.
 *   - QUOTA-AWARE: calls are spaced (AUDIO_TTS_MIN_INTERVAL_MS), a short
 *     per-minute 429 is waited out mid-stream instead of dropping the audio,
 *     and a daily 429 fails fast with Google's own message.
 *   - NO SILENT TRUNCATION: long materials are read in full (up to
 *     AUDIO_MAX_CHARS) since cost now follows listening, not length.
 *   - FULLY CACHED AUDIO is served as a real seekable file (Content-Length +
 *     HTTP Range) assembled from the chunk table, slice by slice, never held in memory.
 *   - STALE-PROOF: the cache key is the text itself, so a regenerated lesson
 *     can never be answered with old audio.
 *
 * Tunables (all optional env vars):
 *   AUDIO_CHUNK_CHARS           chars per Gemini call        (default 4500)
 *   AUDIO_FIRST_CHUNK_CHARS     size of the first chunk; smaller = faster
 *                               start, but costs one extra call (default = chunk size)
 *   AUDIO_LEAD_SECONDS          how far ahead of the listener to synthesize (default 60)
 *   AUDIO_TTS_MIN_INTERVAL_MS   min gap between Gemini calls (default 20000 = 3/min; 0 on paid tiers)
 *   AUDIO_MAX_QUOTA_WAIT_MS     longest 429 cooldown worth waiting out mid-stream (default 90000)
 *   AUDIO_MAX_CHARS             hard ceiling on one piece of audio (default 200000)
 */

const CACHE_VERSION = 'v1'; // bump to invalidate every cached chunk
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // 16-bit mono PCM

interface Pcm {
  pcm: Buffer;
  sampleRate: number;
}

interface LiveState {
  gone: boolean; // the listener disconnected before we finished
  headerSent: boolean;
  startedAt: number; // ms timestamp of the first byte sent
  secondsSent: number; // seconds of audio written to the listener so far
  sampleRate: number;
}

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  private readonly chunkChars = envInt('AUDIO_CHUNK_CHARS', 4500, 500, 8000);
  private readonly firstChunkChars = envInt('AUDIO_FIRST_CHUNK_CHARS', 0, 0, 8000) || this.chunkChars;
  private readonly leadSeconds = envInt('AUDIO_LEAD_SECONDS', 60, 5, 600);
  private readonly minIntervalMs = envInt('AUDIO_TTS_MIN_INTERVAL_MS', 20_000, 0, 600_000);
  private readonly maxQuotaWaitMs = envInt('AUDIO_MAX_QUOTA_WAIT_MS', 90_000, 0, 600_000);
  private readonly maxChars = envInt('AUDIO_MAX_CHARS', 200_000, 1_000, 2_000_000);

  private nextSlotAt = 0;
  private readonly inflight = new Map<string, Promise<Pcm>>();

  constructor(
    private gemini: GeminiService,
  ) {}

  /** Where chunks are cached (a size-capped folder on disk, or nowhere at all) - never the database. */
  private readonly store = new AudioChunkStore();

  getAvailableVoices() {
    return this.gemini.getAvailableVoices();
  }

  /**
   * Streams audio for (refType, refId) straight to `res`.
   *
   * `rawText` may be a single string or an array of independent segments (for
   * example one entry per module). Each segment is chunked on its own, so the
   * chunks of "module 3" are byte-for-byte the same whether it is played alone
   * or as part of the whole tutorial - and therefore only ever paid for once.
   * Plain strings keep working unchanged.
   */
  async serveAudio(
    req: Request,
    res: Response,
    refType: AudioRefType,
    refId: string,
    rawText: string | string[],
    voice?: string,
  ): Promise<void> {
    const voiceName = this.gemini.assertValidVoiceName(voice);

    const chunks = this.prepareChunks(rawText, refType, refId);
    const keys = chunks.map((c) => chunkKey(voiceName, c));

    // Everything already synthesized? Then serve a real, seekable file - zero Gemini calls.
    const located = await this.store.locate(keys);
    if (located.every(Boolean)) {
      await this.sendFromChunks(req, res, located as ChunkRef[], keys, voiceName);
      return;
    }

    await this.streamLive(res, refType, refId, voiceName, chunks, keys, located);
  }

  // ---------------------------------------------------------------------------
  // Live path: some chunks still need synthesizing
  // ---------------------------------------------------------------------------

  private async streamLive(
    res: Response,
    refType: AudioRefType,
    refId: string,
    voiceName: string,
    chunks: string[],
    keys: string[],
    located: Array<ChunkRef | null>,
  ): Promise<void> {
    const state: LiveState = { gone: false, headerSent: false, startedAt: 0, secondsSent: 0, sampleRate: 24000 };
    // 'close' also fires after a normal end(); only a close BEFORE the response finished means the listener left.
    res.on('close', () => {
      if (!res.writableFinished) state.gone = true;
    });

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (state.gone) break;

        const ref = located[i];
        if (ref) {
          // Already paid for - stream it straight from the cache, no pacing needed.
          await this.writeCachedChunk(res, state, ref);
          continue;
        }

        // Needs a Gemini call: only make it when the listener is about to run out of audio.
        await this.waitUntilListenerNeedsMore(state);
        if (state.gone) break;

        const { pcm, sampleRate } = await this.synthesizeShared(keys[i], chunks[i], voiceName, () => state.gone);
        if (state.gone) break; // already cached by synthesizeShared - nothing was wasted
        await this.writePcm(res, state, pcm, sampleRate);
      }
    } catch (err) {
      if (state.gone) return; // nobody is listening; the cache keeps whatever was finished
      if (!res.headersSent) throw err;
      this.logger.error(`Audio streaming failed after playback started for ${refType}/${refId}: ${(err as Error).message}`);
      res.destroy();
      return;
    }

    if (!res.writableEnded && !state.gone) res.end();
  }

  /** Sleeps while the listener still has more than `leadSeconds` of audio buffered - this is what ties cost to listening. */
  private async waitUntilListenerNeedsMore(state: LiveState): Promise<void> {
    while (!state.gone && state.headerSent) {
      const elapsed = (Date.now() - state.startedAt) / 1000;
      const buffered = state.secondsSent - elapsed;
      if (buffered <= this.leadSeconds) return;
      await sleep(Math.min(2000, (buffered - this.leadSeconds) * 1000));
    }
  }

  private ensureHeader(res: Response, state: LiveState, sampleRate: number): void {
    if (state.headerSent) return;
    res.status(200);
    res.set({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store', // a live, growing stream - not a stable cacheable resource
      'Accept-Ranges': 'none', // can't seek a stream whose length isn't known yet; the finished file can be
      'X-Accel-Buffering': 'no', // don't let nginx hold the stream back until it's complete
    });
    res.write(this.gemini.wrapPcmStreamingHeader(sampleRate));
    state.headerSent = true;
    state.startedAt = Date.now();
    state.sampleRate = sampleRate;
  }

  private async writePcm(res: Response, state: LiveState, pcm: Buffer, sampleRate: number): Promise<void> {
    this.ensureHeader(res, state, sampleRate);
    if (!res.write(pcm)) await waitForDrain(res);
    state.secondsSent += pcm.length / (sampleRate * BYTES_PER_SAMPLE);
  }

  private async writeCachedChunk(res: Response, state: LiveState, ref: ChunkRef): Promise<void> {
    this.ensureHeader(res, state, ref.sampleRate);
    const stream = this.store.open(ref, 0, ref.bytes);
    const abort = () => stream.destroy();
    res.once('close', abort);
    try {
      for await (const part of stream) {
        if (state.gone) break;
        if (!res.write(part)) await waitForDrain(res);
      }
    } finally {
      res.off('close', abort);
      stream.destroy();
    }
    state.secondsSent += ref.bytes / (ref.sampleRate * BYTES_PER_SAMPLE);
  }

  // ---------------------------------------------------------------------------
  // Synthesis (shared, throttled, retried, always cached)
  // ---------------------------------------------------------------------------

  /** One Gemini call per distinct chunk, no matter how many listeners ask for it at once. */
  private synthesizeShared(key: string, text: string, voice: string, isGone: () => boolean): Promise<Pcm> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const job = (async (): Promise<Pcm> => {
      // Someone may have finished this chunk between our lookup and now.
      const done = (await this.store.locate([key]))[0];
      if (done) return { pcm: await this.store.read(done), sampleRate: done.sampleRate };

      const result = await this.synthesizeWithRetry(text, voice, isGone);
      try {
        await this.store.store(key, result.pcm, result.sampleRate);
      } catch (err) {
        // The audio is already in hand; failing to cache must never fail the listen.
        this.logger.warn(`Could not cache audio chunk ${key.slice(0, 12)}: ${(err as Error).message}`);
      }
      return result;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, job);
    return job;
  }

  private async synthesizeWithRetry(text: string, voice: string, isGone: () => boolean): Promise<Pcm> {
    let quotaWaits = 0;
    let transientRetries = 0;
    for (;;) {
      await this.acquireSlot();
      try {
        return await this.gemini.generateSpeechChunk(text, voice);
      } catch (err) {
        if (isGone()) throw err;

        // Short per-minute limit: the listener still has buffered audio, so wait it out instead of cutting them off.
        if (err instanceof HttpException && err.getStatus() === 429) {
          const wait = this.gemini.getTtsCooldownMs();
          if (quotaWaits < 2 && wait > 0 && wait <= this.maxQuotaWaitMs) {
            quotaWaits++;
            this.logger.warn(`Gemini TTS rate-limited - waiting ${Math.ceil(wait / 1000)}s then retrying.`);
            await sleep(wait + 1000);
            continue;
          }
          throw err; // daily quota (or too long to wait): surface Google's message
        }

        // One retry for a transient failure (e.g. the model returned no audio).
        if (
          (err instanceof ServiceUnavailableException || err instanceof InternalServerErrorException) &&
          transientRetries < 1
        ) {
          transientRetries++;
          await sleep(2000);
          continue;
        }
        throw err;
      }
    }
  }

  /** Spaces out Gemini calls so a free-tier requests-per-minute cap isn't tripped by concurrent listeners. */
  private async acquireSlot(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + this.minIntervalMs;
    if (at > now) await sleep(at - now);
  }

  // ---------------------------------------------------------------------------
  // Fully cached path: a real, seekable WAV assembled from the chunk table
  // ---------------------------------------------------------------------------

  private async sendFromChunks(
    req: Request,
    res: Response,
    refs: ChunkRef[],
    keys: string[],
    voiceName: string,
  ): Promise<void> {
    const sampleRate = refs[0].sampleRate;
    const pcmBytes = refs.reduce((sum, r) => sum + r.bytes, 0);
    const total = WAV_HEADER_BYTES + pcmBytes;
    const etag = `"${createHash('sha1').update(voiceName).update(keys.join(',')).digest('hex')}"`;

    // The ETag is derived from the text itself, so it is safe to revalidate and can never go stale.
    const baseHeaders = {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.status(304).set(baseHeaders).end();
      return;
    }

    const range = parseRange(req.headers.range, total);
    if (range === 'unsatisfiable') {
      res.status(416).set({ 'Content-Range': `bytes */${total}` }).end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;

    res.status(range ? 206 : 200).set({
      ...baseHeaders,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    });

    let closed = false;
    res.on('close', () => {
      if (!res.writableFinished) closed = true;
    });

    try {
      if (start < WAV_HEADER_BYTES) {
        const header = wavHeader(pcmBytes, sampleRate);
        res.write(header.subarray(start, Math.min(end + 1, WAV_HEADER_BYTES)));
      }

      let chunkStart = WAV_HEADER_BYTES;
      for (const ref of refs) {
        if (closed || chunkStart > end) break;
        const chunkEnd = chunkStart + ref.bytes - 1;
        if (chunkEnd >= start) {
          const from = Math.max(start, chunkStart) - chunkStart;
          const to = Math.min(end, chunkEnd) - chunkStart; // inclusive
          const stream = this.store.open(ref, from, to + 1); // end is exclusive
          const abort = () => stream.destroy();
          res.once('close', abort);
          try {
            for await (const part of stream) {
              if (closed) break;
              if (!res.write(part)) await waitForDrain(res);
            }
          } finally {
            res.off('close', abort);
            stream.destroy();
          }
        }
        chunkStart = chunkEnd + 1;
      }
    } catch (err) {
      if (closed) return;
      this.logger.error(`Serving cached audio failed: ${(err as Error).message}`);
      res.destroy();
      return;
    }
    if (!res.writableEnded && !closed) res.end();
  }

  // ---------------------------------------------------------------------------
  // Chunk preparation
  // ---------------------------------------------------------------------------

  private prepareChunks(rawText: string | string[], refType: AudioRefType, refId: string): string[] {
    const segments = (Array.isArray(rawText) ? rawText : [rawText]).map(stripMarkdownForSpeech).filter(Boolean);
    if (!segments.length) throw new BadRequestException('There is no content to read aloud yet.');

    // Cost follows listening now, so this ceiling is only a sanity guard against absurd input.
    let budget = this.maxChars;
    const kept: string[] = [];
    for (const seg of segments) {
      if (budget <= 0) break;
      kept.push(seg.length > budget ? seg.slice(0, budget) : seg);
      budget -= seg.length;
    }
    if (budget < 0) this.logger.warn(`Truncating TTS input for ${refType}/${refId} to ${this.maxChars} chars`);

    const chunks: string[] = [];
    kept.forEach((seg, i) => {
      chunks.push(...splitIntoChunks(seg, this.chunkChars, i === 0 ? this.firstChunkChars : this.chunkChars));
    });
    return chunks;
  }

  /** Housekeeping: trims the on-disk cache to its size cap. (Also runs automatically as chunks are added.) */
  async pruneStaleChunks(): Promise<number> {
    return this.store.prune();
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== undefined && process.env[name] !== ''
    ? Math.min(max, Math.max(min, Math.trunc(n)))
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves when the socket drains OR the listener disconnects, so a vanished client can never hang the stream. */
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

function chunkKey(voice: string, text: string): string {
  return createHash('sha256').update(`${CACHE_VERSION}\u0000${voice}\u0000${text}`).digest('hex');
}

/** A complete 44-byte WAV header for `dataBytes` of 16-bit mono PCM. */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * RFC 7233 single-range parsing: `a-b`, `a-` and suffix `-n`. Returns null for a
 * missing/malformed/multi-range header (serve the whole file) and
 * 'unsatisfiable' when the range lies outside the file.
 */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;

  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }
  if (start >= total || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Splits text into chunks at sentence boundaries, each at most `maxChars` (the
 * first at most `firstMaxChars`). A single sentence longer than the limit - e.g.
 * a stripped table with no full stops - is broken on word boundaries so no
 * request ever exceeds the limit. Deterministic: same text -> same chunks, which
 * is what lets the chunk cache be shared.
 */
function splitIntoChunks(text: string, maxChars: number, firstMaxChars = maxChars): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).flatMap((s) => splitLongSentence(s, maxChars));
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? firstMaxChars : maxChars;
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const parts: string[] = [];
  let current = '';
  for (const word of sentence.split(/\s+/)) {
    if (word.length > maxChars) {
      if (current) parts.push(current);
      current = '';
      for (let i = 0; i < word.length; i += maxChars) parts.push(word.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + 1 + word.length > maxChars) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}
