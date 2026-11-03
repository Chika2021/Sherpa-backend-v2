import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';

/** The primary key plus up to five backups: GEMINI_API_KEY, GEMINI_API_KEY_2 ... GEMINI_API_KEY_6. */
export const GEMINI_KEY_ENV_VARS = [
  'GEMINI_API_KEY',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY_3',
  'GEMINI_API_KEY_4',
  'GEMINI_API_KEY_5',
  'GEMINI_API_KEY_6',
] as const;

/** Reads every configured key, in priority order, skipping blanks and duplicates. */
export function readGeminiKeys(get: (name: string) => string | undefined): string[] {
  const keys: string[] = [];
  for (const name of GEMINI_KEY_ENV_VARS) {
    const value = get(name)?.trim();
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

type KeyFailure = 'quota' | 'key';

/**
 * Is this error the KEY's fault (so another key might work), as opposed to the request's
 * (bad prompt, unknown model, safety block), the network, or Google being overloaded (those
 * would fail the same way on every key and are handled by the existing retry logic)?
 */
export function classifyKeyFailure(err: unknown): { kind: KeyFailure; keyWide: boolean } | null {
  const message = err instanceof Error ? err.message : String(err);
  const detail = `${message} ${JSON.stringify((err as any)?.errorDetails ?? '')}`;
  const status = Number((err as any)?.status ?? (err as any)?.code);

  if (status === 429 || /\[429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(detail)) {
    return { kind: 'quota', keyWide: false }; // quotas are per model
  }
  const invalidKey = /api key not valid|api_key_invalid|api key expired|key (has been )?(suspended|disabled|revoked)|leaked/i.test(detail);
  if (invalidKey) return { kind: 'key', keyWide: true };
  if (status === 401 || status === 403 || /\[40[13]\b|permission denied|PERMISSION_DENIED|UNAUTHENTICATED/i.test(detail)) {
    return { kind: 'key', keyWide: false }; // e.g. this key isn't allowed to use this particular model
  }
  return null;
}

class KeyEntry {
  /** model -> when it may be tried again (quota hit, or key not permitted for that model) */
  readonly cooldowns = new Map<string, number>();
  /** The whole key is rejected (invalid / expired / revoked) until this time. */
  keyDownUntil = 0;
  private legacyClient?: GoogleGenerativeAI;
  private genAiClient?: GoogleGenAI;

  constructor(readonly key: string, public slot: number) {}

  /** The legacy SDK client (text generation). */
  legacy(): GoogleGenerativeAI {
    return (this.legacyClient ??= new GoogleGenerativeAI(this.key));
  }

  /** The newer SDK client (text-to-speech). */
  genai(): GoogleGenAI {
    return (this.genAiClient ??= new GoogleGenAI({ apiKey: this.key }));
  }

  isCooling(cooldownKey: string, now: number): boolean {
    if (this.keyDownUntil > now) return true;
    const until = this.cooldowns.get(cooldownKey);
    if (until === undefined) return false;
    if (until <= now) {
      this.cooldowns.delete(cooldownKey);
      return false;
    }
    return true;
  }
}

/**
 * Several Gemini API keys behind one interface, with automatic failover.
 *
 * Keys are used in priority order (GEMINI_API_KEY first). When a call fails because THAT KEY
 * is out of quota (429) or is rejected (invalid / expired / revoked / not permitted), the same
 * request is immediately retried on the next key, and the failed key is skipped for a while so
 * later requests don't waste a round-trip on it. It then comes back on its own once its quota
 * window has passed. Anything else (bad request, unknown model, safety block, network, timeout,
 * overload) is rethrown untouched, so the rest of GeminiService's error handling is unchanged.
 *
 * If every key is unusable the last real error is thrown, exactly as with a single key.
 */
export class GeminiKeyPool {
  private readonly logger = new Logger('GeminiKeys');
  private entries: KeyEntry[] = [];
  private byKey = new Map<string, KeyEntry>();
  private signature = '';
  private readonly lastFailure = new Map<string, unknown>();
  // Used only when no key is configured, so the behaviour (Google's own "API key not valid") is the same as before.
  private readonly placeholder = new KeyEntry('missing-key', 1);

  constructor(
    private readonly getKeys: () => string[],
    private readonly retryHintMs: (err: unknown) => number | null,
  ) {
    this.sync();
  }

  /** How many keys are configured. */
  get size(): number {
    this.sync();
    return this.entries.length;
  }

  /** Drop-in for `GoogleGenerativeAI#getGenerativeModel`, but every call is key-failover protected. */
  getGenerativeModel(params: any): ReturnType<GoogleGenerativeAI['getGenerativeModel']> {
    // Typed as the SDK's own model type so every call site keeps its exact type information.
    return new PooledModel(this, params) as unknown as ReturnType<GoogleGenerativeAI['getGenerativeModel']>;
  }

  /** Runs `fn` with a key, moving to the next key when this one is out of quota or rejected. */
  async run<T>(cooldownKey: string, fn: (entry: KeyEntry) => Promise<T>): Promise<T> {
    this.sync();
    const all = this.entries.length ? this.entries : [this.placeholder];
    const failoverPossible = all.length > 1;
    const now = Date.now();
    const usable = all.filter((e) => !e.isCooling(cooldownKey, now));
    if (!usable.length) {
      throw this.lastFailure.get(cooldownKey) ?? new Error('Every Gemini API key is temporarily out of quota or rejected.');
    }

    let lastErr: unknown;
    for (let i = 0; i < usable.length; i++) {
      const entry = usable[i];
      try {
        return await fn(entry);
      } catch (err) {
        const failure = classifyKeyFailure(err);
        if (!failure || !failoverPossible) throw err; // not a key problem (or nothing to fail over to)
        lastErr = err;
        this.lastFailure.set(cooldownKey, err);
        this.coolDown(entry, cooldownKey, failure, err);
        const next = usable[i + 1];
        this.logger.warn(
          `Gemini API key #${entry.slot} ${failure.kind === 'quota' ? 'is out of quota' : 'was rejected'} for "${cooldownKey}"` +
            (next ? ` - switching to key #${next.slot}.` : ' - no more keys to try.'),
        );
      }
    }
    throw lastErr;
  }

  /** Safe to expose: slot numbers and state only, never the keys themselves. */
  describe(): Array<{ slot: number; state: 'ok' | 'cooling' | 'rejected'; retryInSeconds?: number }> {
    this.sync();
    const now = Date.now();
    return this.entries.map((e) => {
      if (e.keyDownUntil > now) {
        return { slot: e.slot, state: 'rejected' as const, retryInSeconds: Math.ceil((e.keyDownUntil - now) / 1000) };
      }
      const soonest = [...e.cooldowns.values()].filter((t) => t > now).sort((a, b) => a - b)[0];
      return soonest
        ? { slot: e.slot, state: 'cooling' as const, retryInSeconds: Math.ceil((soonest - now) / 1000) }
        : { slot: e.slot, state: 'ok' as const };
    });
  }

  private coolDown(entry: KeyEntry, cooldownKey: string, failure: { kind: KeyFailure; keyWide: boolean }, err: unknown) {
    const now = Date.now();
    if (failure.kind === 'key' && failure.keyWide) {
      entry.keyDownUntil = now + 10 * 60_000; // an invalid key won't fix itself - re-check occasionally
      return;
    }
    let ms: number;
    if (failure.kind === 'quota') {
      const hint = this.retryHintMs(err);
      const daily = /PerDay|per day|daily/i.test(String((err as any)?.message ?? '') + JSON.stringify((err as any)?.errorDetails ?? ''));
      ms = hint !== null ? Math.max(1_000, hint) : daily ? 15 * 60_000 : 60_000;
    } else {
      ms = 10 * 60_000; // not permitted for this model
    }
    entry.cooldowns.set(cooldownKey, now + ms);
  }

  /** Re-reads the configured keys; entries (and their cooldown state) survive a refresh. */
  private sync(): void {
    const keys = this.getKeys();
    const signature = keys.join('\u0000');
    if (signature === this.signature) return;
    this.signature = signature;
    const next = new Map<string, KeyEntry>();
    this.entries = keys.map((key, i) => {
      const entry = this.byKey.get(key) ?? new KeyEntry(key, i + 1);
      entry.slot = i + 1;
      next.set(key, entry);
      return entry;
    });
    this.byKey = next;
  }
}

/** Same surface GeminiService uses on a real SDK model object (`generateContent` and the config fields it reads). */
class PooledModel {
  readonly model: string;
  readonly generationConfig: any;
  readonly safetySettings: any;
  readonly tools: any;
  readonly toolConfig: any;
  readonly systemInstruction: any;

  constructor(
    private readonly pool: GeminiKeyPool,
    private readonly params: any,
  ) {
    this.model = params.model;
    this.generationConfig = params.generationConfig;
    this.safetySettings = params.safetySettings;
    this.tools = params.tools;
    this.toolConfig = params.toolConfig;
    this.systemInstruction = params.systemInstruction;
  }

  generateContent(request: any) {
    // Grounded (Google Search) calls have their own, smaller quota - track them separately.
    const cooldownKey = this.tools?.length ? `${this.params.model}#grounded` : this.params.model;
    return this.pool.run(cooldownKey, (entry) => entry.legacy().getGenerativeModel(this.params).generateContent(request));
  }
}
