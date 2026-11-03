export const AI_TRAINING_CATEGORIES = [
  'DATA_ANNOTATION',
  'MODEL_EVALUATION', // RLHF, response rating, preference ranking
  'DOMAIN_EXPERT', // doctors, lawyers, mathematicians, etc. training models
  'CODING_TRAINER',
  'LINGUIST', // multilingual / translation / transcription for models
  'RED_TEAMING',
  'GENERAL_AI_TRAINING',
] as const;

export type AiTrainingCategory = (typeof AI_TRAINING_CATEGORIES)[number];

export interface Classification {
  category: AiTrainingCategory;
  /** Higher = more confident this is genuinely AI-training work. */
  score: number;
}

// STRONG: appearing in a job TITLE is enough on its own to call it AI-training work.
const TITLE_RULES: Array<{ re: RegExp; category: AiTrainingCategory }> = [
  { re: /\b(rlhf|preference\s+rank|response\s+(rater|ranker|evaluator))\b/i, category: 'MODEL_EVALUATION' },
  { re: /\b(ai|llm|model|chatbot|generative)\s+(trainer|tutor|evaluator|rater|reviewer|grader)\b/i, category: 'GENERAL_AI_TRAINING' },
  { re: /\b(search|ads?)\s+(quality\s+)?rater\b/i, category: 'MODEL_EVALUATION' },
  { re: /\b(data|image|video|audio|text)\s+(annotat|label|tagg)\w*/i, category: 'DATA_ANNOTATION' },
  { re: /\b(annotator|labell?er)\b/i, category: 'DATA_ANNOTATION' },
  { re: /\bhuman\s+data\b/i, category: 'DATA_ANNOTATION' },
  { re: /\b(ai|llm)\s+red[\s-]?team/i, category: 'RED_TEAMING' },
  { re: /\bprompt\s+(writer|evaluator|specialist|contributor)\b/i, category: 'MODEL_EVALUATION' },
  { re: /\b(ai|llm|model)\s+(training|data)\s+(specialist|expert|contributor|analyst)\b/i, category: 'GENERAL_AI_TRAINING' },
  { re: /\b(coding|code|software|python|javascript)\s+(ai\s+)?(trainer|evaluator|annotator|reviewer)\b/i, category: 'CODING_TRAINER' },
  { re: /\b(linguist|translator|transcri\w+)\b.*\b(ai|llm|model|training)\b/i, category: 'LINGUIST' },
  { re: /\b(ai|llm)\b.*\b(linguist|multilingual\s+(specialist|expert))\b/i, category: 'LINGUIST' },
  {
    re: /\b(expert|specialist|contributor)\b.*\b(ai\s+training|model\s+training|training\s+(ai|llm|models?))\b/i,
    category: 'DOMAIN_EXPERT',
  },
];

// WEAK: body-text signals. Need several to count, because words like
// "annotation" or "model" show up in ordinary engineering postings.
const BODY_SIGNALS: RegExp[] = [
  /\brlhf\b/i,
  /reinforcement\s+learning\s+from\s+human\s+feedback/i,
  /\b(rate|rank|evaluate|compare|grade)\s+(model|ai|llm|chatbot)\s+(responses?|outputs?|answers?)/i,
  /\btrain(ing)?\s+(large\s+language\s+models?|llms?|ai\s+models?|generative\s+ai)/i,
  /\bdata\s+(annotation|labell?ing)\b/i,
  /\bwrite\s+(prompts?|ideal\s+responses?)\b/i,
  /\bred[\s-]?team(ing)?\b/i,
  /\b(supervised\s+fine[\s-]?tuning|sft)\b/i,
  /\bai\s+training\b/i,
];

// Titles that look similar but are engineering/management roles, not training work.
const NEGATIVE_TITLE = /\b(engineer|developer|scientist|architect|manager|director|vp|head\s+of|recruiter|sales|account)\b/i;

export function classifyAiTraining(title: string, description = ''): Classification | null {
  const t = title || '';

  for (const rule of TITLE_RULES) {
    if (rule.re.test(t)) {
      // "Data Annotation Engineer" is a tooling role; still allow it if the
      // title also names the rating/annotating job itself (e.g. "Annotator").
      if (NEGATIVE_TITLE.test(t) && !/\b(annotator|labell?er|trainer|rater|evaluator|tutor)\b/i.test(t)) continue;
      return { category: rule.category, score: 3 };
    }
  }

  if (NEGATIVE_TITLE.test(t)) return null;

  const hits = BODY_SIGNALS.filter((re) => re.test(description)).length;
  if (hits >= 2) return { category: inferBodyCategory(description), score: Math.min(hits, 3) };
  return null;
}

/** Best-guess category for a listing that a trusted source already vouches for as AI-training work. */
export function inferCategory(title: string, description = ''): AiTrainingCategory {
  for (const rule of TITLE_RULES) if (rule.re.test(title || '')) return rule.category;
  return inferBodyCategory(`${title} ${description}`);
}

function inferBodyCategory(text: string): AiTrainingCategory {
  if (/\b(code|coding|python|javascript|software)\b/i.test(text)) return 'CODING_TRAINER';
  if (/\bred[\s-]?team/i.test(text)) return 'RED_TEAMING';
  if (/\b(annotat|labell?ing)\b/i.test(text)) return 'DATA_ANNOTATION';
  if (/\b(rlhf|rank|rate|evaluate)\b/i.test(text)) return 'MODEL_EVALUATION';
  return 'GENERAL_AI_TRAINING';
}

/** Best-effort pay extraction from free text: "$25-$45/hour", "$30 per hour", "up to $60/hr". */
export function extractHourlyPay(text: string): { min?: number; max?: number; currency?: string; text?: string } {
  const range = text.match(/\$\s?(\d{2,3}(?:\.\d+)?)\s?(?:-|–|to)\s?\$?\s?(\d{2,3}(?:\.\d+)?)\s?(?:\/|per\s)?\s?(?:hr|hour)/i);
  if (range) {
    return { min: Number(range[1]), max: Number(range[2]), currency: 'USD', text: range[0].trim() };
  }
  const single = text.match(/\$\s?(\d{2,3}(?:\.\d+)?)\s?(?:\/|per\s)\s?(?:hr|hour)/i);
  if (single) {
    return { min: Number(single[1]), max: Number(single[1]), currency: 'USD', text: single[0].trim() };
  }
  return {};
}
