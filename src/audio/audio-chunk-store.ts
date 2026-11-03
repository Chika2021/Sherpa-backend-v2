import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

export interface ChunkRef {
  /** The chunk's content key (sha256 of voice + text). */
  id: string;
  /** Length of the PCM audio in bytes. */
  bytes: number;
  sampleRate: number;
}

/** Each file is a 4-byte sample rate followed by the raw 16-bit mono PCM. */
const HEADER_BYTES = 4;
const KEY_RE = /^[a-f0-9]{16,128}$/;
const PRUNE_EVERY_MS = 60_000;

/**
 * Where synthesized audio chunks are kept so Gemini is only called once per
 * distinct piece of text. It is deliberately NOT the database: audio is large and
 * was filling the Postgres quota.
 *
 *   AUDIO_CACHE=disk (default)  small on-disk cache, capped at AUDIO_CACHE_MAX_MB (default 300),
 *                               least-recently-used files deleted first. Lives in AUDIO_CACHE_DIR
 *                               (default ./audio-cache) - not in the publicly served /files folder.
 *   AUDIO_CACHE=none            store nothing anywhere: every play is streamed live from Gemini
 *                               and discarded. Uses no disk and no database, but every play costs
 *                               Gemini TTS calls (the free tier allows very few per day).
 *
 * On hosts with an ephemeral disk the cache simply starts empty after each deploy/restart -
 * harmless, it just refills.
 */
export class AudioChunkStore {
  private readonly logger = new Logger('AudioChunkStore');
  readonly mode: 'disk' | 'none';
  private readonly dir: string;
  private readonly maxBytes: number;
  private lastPruneAt = 0;
  private pruning = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mode = (env.AUDIO_CACHE ?? 'disk').trim().toLowerCase() === 'none' ? 'none' : 'disk';
    this.dir = env.AUDIO_CACHE_DIR?.trim() || path.join(process.cwd(), 'audio-cache');
    const mb = Number(env.AUDIO_CACHE_MAX_MB);
    this.maxBytes = (Number.isFinite(mb) && mb > 0 ? mb : 300) * 1024 * 1024;
    if (this.mode === 'none') this.logger.log('Audio cache is OFF - audio is streamed live and never stored.');
  }

  private fileFor(key: string): string | null {
    return KEY_RE.test(key) ? path.join(this.dir, `${key}.pcm`) : null;
  }

  /** Result is aligned with `keys`; null = not cached. */
  async locate(keys: string[]): Promise<Array<ChunkRef | null>> {
    if (this.mode === 'none') return keys.map(() => null);
    return Promise.all(keys.map((key) => this.locateOne(key)));
  }

  private async locateOne(key: string): Promise<ChunkRef | null> {
    const file = this.fileFor(key);
    if (!file) return null;
    try {
      const handle = await fs.promises.open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (size <= HEADER_BYTES) return null;
        const header = Buffer.alloc(HEADER_BYTES);
        await handle.read(header, 0, HEADER_BYTES, 0);
        const sampleRate = header.readUInt32BE(0) || 24000;
        // Mark as recently used so pruning removes the coldest files first.
        const now = new Date();
        fs.promises.utimes(file, now, now).catch(() => undefined);
        return { id: key, bytes: size - HEADER_BYTES, sampleRate };
      } finally {
        await handle.close();
      }
    } catch {
      return null; // not cached (or unreadable) - will simply be synthesized
    }
  }

  async store(key: string, pcm: Buffer, sampleRate: number): Promise<void> {
    if (this.mode === 'none') return;
    const file = this.fileFor(key);
    if (!file) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(sampleRate, 0);
    // Write to a temp file then rename, so a reader never sees a half-written chunk.
    const tmp = path.join(this.dir, `${key}.${process.pid}.${Date.now()}.tmp`);
    await fs.promises.writeFile(tmp, Buffer.concat([header, pcm]));
    await fs.promises.rename(tmp, file);
    this.pruneSoon();
  }

  async read(ref: ChunkRef): Promise<Buffer> {
    const file = this.fileFor(ref.id);
    if (!file) throw new Error('Invalid audio chunk key');
    const all = await fs.promises.readFile(file);
    return all.subarray(HEADER_BYTES);
  }

  /** Bytes [start, endExclusive) of the PCM, as an async-iterable stream (supports destroy()). */
  open(ref: ChunkRef, start: number, endExclusive: number): fs.ReadStream {
    const file = this.fileFor(ref.id);
    if (!file) throw new Error('Invalid audio chunk key');
    return fs.createReadStream(file, {
      start: HEADER_BYTES + start,
      end: HEADER_BYTES + endExclusive - 1, // createReadStream's `end` is inclusive
      highWaterMark: 256 * 1024,
    });
  }

  // ---- keeping the cache under its size cap ----

  private pruneSoon() {
    const now = Date.now();
    if (this.pruning || now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    this.pruning = true;
    this.prune()
      .catch((err) => this.logger.warn(`Audio cache pruning failed: ${(err as Error).message}`))
      .finally(() => (this.pruning = false));
  }

  /** Deletes least-recently-used chunks until the cache is at most 90% of its cap. Returns files removed. */
  async prune(): Promise<number> {
    if (this.mode === 'none') return 0;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return 0;
    }
    const files: Array<{ file: string; size: number; mtime: number; tmp: boolean }> = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) files.push({ file, size: st.size, mtime: st.mtimeMs, tmp: name.endsWith('.tmp') });
      } catch {
        /* removed concurrently */
      }
    }
    let removed = 0;
    const staleTmp = Date.now() - 3_600_000;
    for (const f of files.filter((x) => x.tmp && x.mtime < staleTmp)) {
      await fs.promises.rm(f.file, { force: true });
      removed++;
    }
    const chunks = files.filter((f) => !f.tmp).sort((a, b) => a.mtime - b.mtime);
    let total = chunks.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.maxBytes) return removed;
    const target = this.maxBytes * 0.9;
    for (const f of chunks) {
      if (total <= target) break;
      await fs.promises.rm(f.file, { force: true });
      total -= f.size;
      removed++;
    }
    return removed;
  }
}
