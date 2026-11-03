import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Part } from '@google/generative-ai';

/**
 * Fallback text-generation provider used by `GeminiService` when Gemini is
 * unavailable (quota exhausted, outage, network failure, etc). Cerebras
 * exposes an OpenAI-compatible `/v1/chat/completions` endpoint, so this is a
 * plain `fetch` call rather than a dedicated SDK - one less dependency to
 * install, and this file is the only thing that needs to know Cerebras'
 * request/response shape.
 *
 * Every prompt in `gemini.service.ts` already asks the model, IN THE PROMPT
 * TEXT, to return plain JSON/text (see `GeminiService.extractJson`) rather
 * than relying on Gemini-specific structured-output config - so whatever
 * text Cerebras returns is parsed by the exact same downstream code that
 * parses Gemini's response. No feature-specific logic lives here.
 *
 * Required env vars:
 *   CEREBRAS_API_KEY   Cerebras Cloud API key (from https://cloud.cerebras.ai)
 * Optional:
 *   CEREBRAS_MODEL     defaults to "gpt-oss-120b". Cerebras periodically
 *                       retires/renames models (this default itself replaced
 *                       an older one that started 404ing), so whatever is
 *                       configured here is only ever a first guess - see
 *                       `generateText`'s auto-discovery below for what
 *                       happens when it's wrong.
 */
@Injectable()
export class CerebrasService {
  private readonly logger = new Logger(CerebrasService.name);
  private readonly apiKey: string | undefined;
  private readonly endpoint = 'https://api.cerebras.ai/v1/chat/completions';
  private readonly modelsEndpoint = 'https://api.cerebras.ai/v1/models';
  readonly modelName: string;
  // The model actually confirmed to work on this API key, once we know it -
  // starts out equal to modelName but can diverge after auto-discovery (see
  // generateText). Exposed via effectiveModelName() so callers that log/bill
  // by model name (GeminiService.fallbackToCerebras) report what was really
  // used, not just what was configured.
  private resolvedModel: string | undefined;
  private modelIds: string[] | undefined;
  private discovery: Promise<string[]> | null = null;

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('CEREBRAS_API_KEY');
    this.modelName = this.config.get<string>('CEREBRAS_MODEL') || 'gpt-oss-120b';
    if (!this.apiKey) {
      this.logger.warn(
        'CEREBRAS_API_KEY is not set - Cerebras fallback is disabled, so a Gemini outage/quota error ' +
          'will surface to the user as before instead of being retried on Cerebras.',
      );
    }
  }

  /** Whether a Cerebras fallback can actually be attempted. */
  /** Epoch ms until which every call fails fast because the account returned 402 on all models. */
  private billingBlockedUntil = 0;

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** The model that actually served the last successful request, if any - see `resolvedModel`. */
  effectiveModelName(): string {
    return this.resolvedModel ?? this.modelName;
  }

  /**
   * Cerebras' chat completions API is text-only. `GeminiService` sometimes
   * passes a Gemini `Part[]` prompt that includes binary content (an audio
   * clip for voice-answer scoring, for example) - that can't be translated,
   * so this throws rather than silently dropping the audio/image and asking
   * the model to answer a question it was never actually given.
   */
  private toChatText(prompt: string | Part[]): string {
    if (typeof prompt === 'string') return prompt;
    const textParts = prompt.filter((p: any) => typeof p?.text === 'string');
    if (textParts.length !== prompt.length) {
      throw new Error(
        'Cerebras fallback cannot handle this request: it contains non-text content (file/image/audio) ' +
          'that only Gemini can process.',
      );
    }
    return textParts.map((p: any) => p.text).join('\n\n');
  }

  /**
   * Reasoning-capable models (gpt-oss, GLM, ...) narrate their whole
   * chain-of-thought into the SAME `content` field the final answer goes
   * in unless told otherwise - for a prompt asking for plain JSON back,
   * that means paragraphs of "let's search for X... now let's compile the
   * JSON..." ahead of (or instead of) the actual answer. `reasoning_effort:
   * "low"` cuts down how much of that happens, and `reasoning_format:
   * "parsed"` (where supported) moves whatever reasoning remains into its
   * own `message.reasoning` field so `content` is just the final answer.
   * Not every model on this key recognises these fields, so `generateText`
   * retries once without them if a model complains (see there).
   */
  private async completeOnce(
    content: string,
    model: string,
    timeoutMs: number,
    useReasoningControls: boolean,
    maxTokens?: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          temperature: 0.4,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(useReasoningControls ? { reasoning_effort: 'low', reasoning_format: 'parsed' } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`Cerebras request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err: any = new Error(`Cerebras request failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
      err.status = res.status;
      // A model that doesn't recognise reasoning_effort/reasoning_format
      // rejects the whole request (400/422) rather than ignoring the
      // unknown fields - worth telling `generateText` apart from a real
      // failure so it can retry without them instead of giving up.
      err.unsupportedParams =
        useReasoningControls &&
        (res.status === 400 || res.status === 422) &&
        /reasoning[_-]?(effort|format)/i.test(body);
      throw err;
    }

    const data: any = await res.json();
    const message = data?.choices?.[0]?.message;
    // With reasoning_format: "parsed", any leftover chain-of-thought comes
    // back in `message.reasoning`, separate from `content` - never treat it
    // as part of the answer.
    const text = message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Cerebras returned an empty response.');
    }
    return text;
  }

  /**
   * `completeOnce` plus ONE quick retry for transient failures (5xx, dropped
   * connection, empty reply). Not retried: timeouts (already a full wait),
   * and 4xx errors, which are handled by `generateText`'s model-hopping.
   */
  private async completeWithRetry(
    content: string,
    model: string,
    timeoutMs: number,
    useReasoningControls: boolean,
    maxTokens?: number,
  ): Promise<string> {
    try {
      return await this.completeOnce(content, model, timeoutMs, useReasoningControls, maxTokens);
    } catch (err) {
      const status = (err as any)?.status as number | undefined;
      const message = (err as Error)?.message ?? '';
      const aborted = /abort|timed out/i.test(message);
      const transient = status === undefined ? !aborted : status >= 500;
      if (!transient) throw err;
      this.logger.warn(`Cerebras transient failure (${status ?? message.slice(0, 80)}) - retrying once.`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return this.completeOnce(content, model, timeoutMs, useReasoningControls, maxTokens);
    }
  }

  /**
   * Asks Cerebras itself (GET /v1/models) which models this API key can list
   * at all, ordered with the configured CEREBRAS_MODEL first if it's in that
   * list. Cerebras' catalog changes over time (models get renamed/retired,
   * and access/billing can differ per model tier), so this is what lets a
   * wrong/outdated CEREBRAS_MODEL - or one that's hit a model-specific
   * paywall - self-heal by trying siblings instead of failing every call
   * until someone edits the .env file. Concurrent callers share one
   * in-flight discovery request rather than each firing their own. Cached
   * for the life of the process; Cerebras' catalog doesn't change mid-run.
   */
  private async discoverModelIds(): Promise<string[]> {
    if (this.modelIds) return this.modelIds;
    if (this.discovery) return this.discovery;
    this.discovery = (async () => {
      try {
        const res = await fetch(this.modelsEndpoint, { headers: { Authorization: `Bearer ${this.apiKey}` } });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} listing Cerebras models`);
        }
        const data: any = await res.json();
        const ids: string[] = ((data?.data ?? []) as any[]).map((m) => m?.id).filter((id): id is string => !!id);
        if (ids.length === 0) {
          throw new Error('Cerebras returned no models for this API key');
        }
        // Configured model first (worth trying again in case its earlier
        // failure was transient), then the rest in whatever order Cerebras
        // returned them.
        const ordered = ids.includes(this.modelName) ? [this.modelName, ...ids.filter((id) => id !== this.modelName)] : ids;
        this.modelIds = ordered;
        return ordered;
      } finally {
        this.discovery = null;
      }
    })();
    return this.discovery;
  }

  /**
   * Runs one Cerebras chat completion and returns the assistant's text.
   * Tries the configured/last-known-working model first. If that specific
   * call fails with a model-availability problem - 404 (doesn't exist / not
   * accessible on this key), 402 (this model needs billing this key doesn't
   * have), or 429 (this model's own quota is exhausted) - that's worth
   * working around rather than failing the fallback outright: this method
   * lists every model the key can access (see `discoverModelIds`) and tries
   * each one in turn until one works or they're all exhausted. A 402/429 is
   * often account-wide rather than per-model, so this isn't guaranteed to
   * find a working model, but it costs little to check since this is
   * already the last-resort fallback after Gemini's own retries/model-
   * hopping have failed. Any OTHER failure (network, timeout, empty
   * response) is not retried against other models - it's not a model-
   * availability problem, so trying a different model wouldn't help - and a
   * failure here just means the original Gemini error is what the caller
   * sees.
   */
  async generateText(prompt: string | Part[], timeoutMs = 45_000, maxTokens?: number): Promise<string> {
    if (!this.apiKey) {
      throw new Error('CEREBRAS_API_KEY is not configured.');
    }
    // Account-wide 402 seen recently: fail instantly instead of probing every model again on every AI call.
    if (Date.now() < this.billingBlockedUntil) {
      const blocked: any = new Error('Cerebras is paused: the account returned 402 Payment Required recently.');
      blocked.status = 402;
      throw blocked;
    }
    const content = this.toChatText(prompt);
    const tried = new Set<string>();
    let candidates = [this.resolvedModel ?? this.modelName];
    let lastErr: unknown;

    while (candidates.length > 0) {
      const model = candidates.shift()!;
      if (tried.has(model)) continue;
      tried.add(model);

      try {
        try {
          const text = await this.completeWithRetry(content, model, timeoutMs, true, maxTokens);
          this.resolvedModel = model; // confirmed working - try this one first next time
          return text;
        } catch (err) {
          if (!(err as any)?.unsupportedParams) throw err;
          // This model doesn't support reasoning_effort/reasoning_format - retry
          // once, plainly, before treating it as a real failure.
          const text = await this.completeWithRetry(content, model, timeoutMs, false, maxTokens);
          this.resolvedModel = model;
          return text;
        }
      } catch (err) {
        lastErr = err;
        const status = (err as any)?.status;
        if (status !== 404 && status !== 402 && status !== 429) throw err;

        this.logger.warn(
          `Cerebras: model "${model}" unavailable (HTTP ${status}) - checking for another model this key can access.`,
        );
        if (candidates.length === 0) {
          try {
            const ids = await this.discoverModelIds();
            candidates = ids.filter((id) => !tried.has(id));
          } catch (discoverErr) {
            this.logger.error(`Cerebras: could not list available models: ${(discoverErr as Error).message}`);
            throw err;
          }
        }
      }
    }

    // Every model this key can even list still failed with a
    // billing/availability error - most likely the account itself has no
    // usable quota/credits rather than any one model being misconfigured.
    if ((lastErr as any)?.status === 402) {
      const cooldownMs = Number(process.env.CEREBRAS_402_COOLDOWN_MS) || 15 * 60_000;
      this.billingBlockedUntil = Date.now() + cooldownMs;
      this.logger.error(
        'Cerebras: every accessible model returned 402 Payment Required - this looks like an account-wide ' +
          'billing issue, not a model-name problem. Add credits/billing at https://cloud.cerebras.ai and this ' +
          'fallback will start working again automatically, nothing else to change here.',
      );
    }
    throw lastErr;
  }
}