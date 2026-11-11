/**
 * SINGLE SOURCE OF TRUTH FOR BILLING.
 *
 * The whole pricing model is one sentence: **$3 buys 5 AI tokens**, and one
 * AI generation costs 1 token. That works out to $0.60 per token / per AI
 * call, and every price in the app is derived from those two numbers - there
 * is no face value, no 50/50 purchase split, and no per-model metering of
 * Google's real Gemini cost anywhere in the codebase any more. If you want to
 * change what users pay, change BUNDLE_PRICE_USD / BUNDLE_TOKENS (here or via
 * env) and every screen, package, and ledger row follows automatically.
 *
 * Bundles are strictly linear multiples of the $3/5 bundle - no bundle
 * discounts - so "$3 for 5 tokens" stays literally true at every size and
 * the buy screen never has to explain a per-bundle rate.
 */

export interface TokenPricing {
  /** Price of one bundle, in USD. Default 3. */
  bundlePriceUsd: number;
  /** Tokens granted per bundle. Default 5. */
  bundleTokens: number;
  /** Derived: bundlePriceUsd / bundleTokens (default $0.60). */
  pricePerTokenUsd: number;
  /** Smallest custom purchase allowed, in tokens (default one full bundle). */
  minPurchaseTokens: number;
  /** Largest single purchase allowed, in tokens. */
  maxPurchaseTokens: number;
}

export const DEFAULT_BUNDLE_PRICE_USD = 3;
export const DEFAULT_BUNDLE_TOKENS = 5;
export const DEFAULT_MIN_PURCHASE_TOKENS = DEFAULT_BUNDLE_TOKENS;
export const DEFAULT_MAX_PURCHASE_TOKENS = 10_000;

/** Tokens granted to a brand-new account so it can try the app before paying. */
export const FREE_SIGNUP_TOKENS = 5;

/** Rounds a money amount to whole cents without floating-point noise. */
export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Reads pricing from the environment, falling back to the defaults above.
 * `read` is normally `ConfigService.get`, but any (key) => value function
 * works - keeping this pure makes it trivial to unit-test.
 */
export function resolveTokenPricing(read: (key: string) => string | number | undefined): TokenPricing {
  const bundlePriceUsd = positiveNumber(read('BUNDLE_PRICE_USD'), DEFAULT_BUNDLE_PRICE_USD);
  const bundleTokens = Math.floor(positiveNumber(read('BUNDLE_TOKENS'), DEFAULT_BUNDLE_TOKENS));
  const minPurchaseTokens = Math.floor(
    positiveNumber(read('MIN_PURCHASE_TOKENS'), Math.min(DEFAULT_MIN_PURCHASE_TOKENS, bundleTokens)),
  );
  const maxPurchaseTokens = Math.floor(positiveNumber(read('MAX_PURCHASE_TOKENS'), DEFAULT_MAX_PURCHASE_TOKENS));

  return {
    bundlePriceUsd,
    bundleTokens,
    // 4dp is enough for any sane bundle size and keeps 3/5 exact at 0.6.
    pricePerTokenUsd: Math.round((bundlePriceUsd / bundleTokens + Number.EPSILON) * 10000) / 10000,
    minPurchaseTokens,
    maxPurchaseTokens,
  };
}

function positiveNumber(raw: string | number | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** What a given number of tokens costs, in USD. */
export function priceForTokens(tokens: number, pricing: TokenPricing): number {
  return roundUsd(tokens * pricing.pricePerTokenUsd);
}

/** How many whole tokens a given USD amount buys (used by the "spend $X" input). */
export function tokensForUsd(amountUsd: number, pricing: TokenPricing): number {
  return Math.floor(amountUsd / pricing.pricePerTokenUsd);
}

/**
 * The buy-screen bundles: plain multiples of the base bundle. `bundles: 1` is
 * the $3 / 5-token bundle itself; the rest just save the user from typing a
 * custom amount. Same per-token rate at every size, by design.
 */
export interface TokenPackageDefinition {
  id: string;
  label: string;
  bundles: number;
  /** Optional marketing flag the frontend can use to highlight one card. */
  highlight?: boolean;
}

export const TOKEN_PACKAGE_DEFINITIONS: TokenPackageDefinition[] = [
  { id: 'bundle-1', label: 'Starter', bundles: 1 },
  { id: 'bundle-2', label: 'Standard', bundles: 2 },
  { id: 'bundle-5', label: 'Popular', bundles: 5, highlight: true },
  { id: 'bundle-10', label: 'Pro', bundles: 10 },
  { id: 'bundle-20', label: 'Power', bundles: 20 },
];

export const TOKEN_PACKAGE_IDS = TOKEN_PACKAGE_DEFINITIONS.map((p) => p.id);

export interface ResolvedTokenPackage {
  id: string;
  label: string;
  tokens: number;
  totalUsd: number;
  pricePerTokenUsd: number;
  highlight: boolean;
}

/** Expands the definitions above into concrete token counts and prices. */
export function buildTokenPackages(pricing: TokenPricing): ResolvedTokenPackage[] {
  return TOKEN_PACKAGE_DEFINITIONS.map((pkg) => {
    const tokens = pkg.bundles * pricing.bundleTokens;
    return {
      id: pkg.id,
      label: pkg.label,
      tokens,
      totalUsd: roundUsd(pkg.bundles * pricing.bundlePriceUsd),
      pricePerTokenUsd: pricing.pricePerTokenUsd,
      highlight: !!pkg.highlight,
    };
  });
}

export function findTokenPackage(id: string, pricing: TokenPricing): ResolvedTokenPackage | undefined {
  return buildTokenPackages(pricing).find((p) => p.id === id);
}

/**
 * What each AI feature costs, keyed by the `label` GeminiService already
 * passes for every call. Everything is 1 token by default - so 5 tokens is
 * literally 5 AI generations for $3. Bump an entry here (and only here) if a
 * particular feature turns out to be expensive enough to be worth more than
 * one token; unlisted labels fall back to DEFAULT_FEATURE_TOKEN_COST.
 */
export const DEFAULT_FEATURE_TOKEN_COST = 1;

export const FEATURE_TOKEN_COSTS: Record<string, number> = {
  parseResume: 1,
  buildResume: 1,
  editResume: 1, // AI resume editor: one natural-language edit instruction applied to a resume
  discoverJobs: 1, // heavy fallback path only - see rankJobMatches for the normal (cheap) job-search path
  rankJobMatches: 1,
  generateTailoredResume: 1,
  generateCoverLetter: 1,
  generateInterviewQuestions: 1,
  generateCbtQuestions: 1,
  evaluateVoiceAnswer: 1,
  summarizeVoiceInterview: 1,
  // Live interview with Lora: ONE token per interview session, billed when it starts (liveInterview).
  // The per-turn model calls and the final report are 0 so a long conversation can't be cut off by a
  // zero balance and doesn't cost more the more the candidate says. Raise liveInterview here to reprice it.
  liveInterview: 1,
  liveInterviewTurn: 0,
  liveInterviewSummary: 0,
  generateSkillTutorial: 1,
  generateModuleMaterials: 1,
  findSkillVideos: 1, // one token per "find N videos" search, however many model calls it takes
  generateSkillCbtQuestions: 1,
  generateLabExercises: 1,
  evaluateLabAttempt: 1,
  mapApplicationForm: 1,
  answerApplicationForm: 1, // guided apply: answers every question of a pasted form / link in one call
  askAi: 1,
  // AI Workshop (internship-style practical training on a skill). Each is one token:
  generateWorkshopPlan: 1, // once per workshop: the outline of every level and project
  generateWorkshopUnit: 1, // once per level/project, when the learner starts it (the full step-by-step guide)
  reviewWorkshopStep: 1, // one supervisor review of a submitted checkpoint
  workshopMentor: 1, // one question to the supervisor
};

/** Token cost of one call to the feature identified by `label`. */
export function tokenCostForFeature(label?: string | null): number {
  if (!label) return DEFAULT_FEATURE_TOKEN_COST;
  return FEATURE_TOKEN_COSTS[label] ?? DEFAULT_FEATURE_TOKEN_COST;
}

/** Highest cost any single feature can charge - what preflight must guarantee. */
export function maxFeatureTokenCost(): number {
  return Math.max(DEFAULT_FEATURE_TOKEN_COST, ...Object.values(FEATURE_TOKEN_COSTS));
}
