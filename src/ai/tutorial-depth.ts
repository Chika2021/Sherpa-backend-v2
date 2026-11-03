/**
 * Depth rules for generated skill tutorials ("Build Skill" courses).
 *
 * The product requirement: every module of a generated course is a full
 * book-style chapter that prints to AT LEAST `MIN_MODULE_PAGES` pages. That is
 * enforced in two places that must agree, so the numbers live here:
 *
 *   - GeminiService writes each module's lesson to a word count derived from
 *     these constants (and expands it until it gets there), and
 *   - SkillTutorialPdfService starts every module on a fresh page and reports
 *     how many pages each one actually took, warning if one comes up short.
 *
 * Where the numbers come from: the PDF body is A4, 56pt margins, Helvetica
 * 10.5pt with 2.5pt line gap. Measured with Helvetica's real font metrics,
 * dense unbroken English prose fits ~674 words per page. Real lessons are
 * LESS dense (headings, bullets, code blocks, spacing), so 674 is the
 * worst case for "how few pages could this many words take".
 */

/** The promise made to the learner: no module prints shorter than this. */
export const MIN_MODULE_PAGES = 4;

/** Words per page of unbroken prose in the PDF layout (measured, see above). */
export const PDF_MAX_WORDS_PER_PAGE = 674;

/** Pages every module spends on its title banner, spoken summary, key points and example before the lesson starts. */
export const MODULE_FRONT_MATTER_PAGES = 0.35;

/**
 * Absolute floor for a module's lesson (prose words, code excluded). Even if
 * every page were wall-to-wall dense prose this still prints to MIN_MODULE_PAGES
 * once the front matter is added: (4 - 0.35) * 674 = 2,461 words. A lesson below
 * this is rejected rather than saved.
 */
export const MODULE_HARD_FLOOR_WORDS = Math.ceil((MIN_MODULE_PAGES - MODULE_FRONT_MATTER_PAGES) * PDF_MAX_WORDS_PER_PAGE);

/** Below this the lesson is sent back for expansion (typical real layout: ~5 printed pages). */
export const MODULE_MIN_WORDS = 2_900;

/** What the writing prompt asks for, so a model that lands a bit short still clears MODULE_MIN_WORDS. */
export const MODULE_TARGET_WORDS = 3_300;

/** How many "write more" passes a short lesson gets before generation gives up on it. */
export const MAX_EXPANSION_ROUNDS = 3;

/** A lesson is a chapter of a book: these sections, in this order, each with a rough word budget (sums to ~3,200). */
export const LESSON_SECTIONS: ReadonlyArray<{ title: string; pattern: RegExp; words: number; brief: string }> = [
  {
    title: 'Learning Objectives',
    pattern: /^##\s+.*learning objectives?/im,
    words: 100,
    brief: '4-6 bullet points, each starting with a measurable verb ("Explain...", "Build...", "Diagnose...").',
  },
  {
    title: 'Why This Matters',
    pattern: /^##\s+.*why (this )?matters?/im,
    words: 200,
    brief: 'Where this fits in the skill, what goes wrong without it, and a concrete motivating scenario.',
  },
  {
    title: 'Core Concepts',
    pattern: /^##\s+.*core concepts?/im,
    words: 700,
    brief:
      '3-5 "###" sub-sections, one per major idea. For each: define it, explain the reasoning/mechanism behind it (the WHY, not just the WHAT), and give a small illustrative example.',
  },
  {
    title: 'Worked Example',
    pattern: /^##\s+.*worked example/im,
    words: 450,
    brief:
      'ONE complete example built up step by step. State the problem, solve it in numbered steps, and explain the decision made at every step. Use a code block if the skill involves code.',
  },
  {
    title: 'Real-World Case Study',
    pattern: /^##\s+.*case stud/im,
    words: 350,
    brief: 'A second, DIFFERENT realistic scenario (different data/context from the worked example), walked through and analysed.',
  },
  {
    title: 'Common Mistakes and Misconceptions',
    pattern: /^##\s+.*mistakes?/im,
    words: 300,
    brief: 'At least 5. For each: what people get wrong, why it happens, how to spot it, and how to fix or avoid it.',
  },
  {
    title: 'Edge Cases and Exceptions',
    pattern: /^##\s+.*edge cases?/im,
    words: 200,
    brief: 'At least 3 situations where the usual rule bends or breaks, and how to handle each.',
  },
  {
    title: 'Professional Practice',
    pattern: /^##\s+.*(professional|best) practices?/im,
    words: 250,
    brief:
      'Habits and standards of working practitioners. For Advanced / Super Advanced tiers go further: trade-offs between approaches, performance / scaling / maintainability, and a decision framework for choosing.',
  },
  {
    title: 'Practice Exercises',
    pattern: /^##\s+.*practice exercises?/im,
    words: 350,
    brief:
      '5 exercises of rising difficulty. For each: the task, then "What good looks like" (the expected outcome or an outline of the solution).',
  },
  {
    title: 'Self-Check Questions',
    pattern: /^##\s+.*self[- ]?check/im,
    words: 200,
    brief: '6 questions that test understanding rather than recall, each followed by a concise model answer.',
  },
  {
    title: 'Module Summary',
    pattern: /^##\s+.*summary/im,
    words: 120,
    brief: 'A tight recap of the module, then a bridge that names the next module and why it follows.',
  },
];

/** Typesetting constraints shared by every prompt that produces lesson text (the PDF uses standard fonts). */
export const LESSON_FORMAT_RULES = `FORMAT RULES (the chapter is typeset into a PDF with standard fonts):
- Output ONLY the chapter as Markdown. No preamble, no closing remarks, no JSON, and do NOT wrap it in a code fence.
- Allowed: "##" and "###" headings, paragraphs, **bold**, *italic*, \`inline code\`, "- " bullet lists, "1. " numbered lists,
  "> " blockquote callouts (begin them with Tip:, Warning: or Note:), and fenced code blocks with a language tag.
- Do NOT use tables, images, HTML, emoji or special symbols. Plain ASCII punctuation only: write "->" instead of an arrow,
  ">=" instead of a symbol, straight quotes.
- Write for a real learner: define every term on first use, explain reasoning rather than asserting, and build every example up
  step by step. Never pad with filler or repeat yourself to reach the length - add genuine teaching.`;

/** Number of words of readable prose in a markdown lesson. Fenced code is excluded; list/heading/emphasis markers are not counted. */
export function countProseWords(markdown: string | undefined | null): number {
  if (!markdown) return 0;
  const withoutCode = markdown.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const stripped = withoutCode
    .replace(/^\s*(?:#{1,6}|[-*+]|>|\d+[.)])\s+/gm, ' ')
    .replace(/[*`]/g, ' ');
  return stripped.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Rough printed-page estimate for a module whose lesson has `words` prose words (best case: densest layout). */
export function estimateModulePages(words: number): number {
  return MODULE_FRONT_MATTER_PAGES + words / PDF_MAX_WORDS_PER_PAGE;
}

function withoutFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?(?:```|$)/g, ' ');
}

/** Titles of the required lesson sections that `markdown` does not (yet) contain as a "##" heading. */
export function missingLessonSections(markdown: string): string[] {
  const prose = withoutFences(markdown);
  return LESSON_SECTIONS.filter((section) => !section.pattern.test(prose)).map((section) => section.title);
}

/** True when the lesson stops before its closing "Module Summary" - the signature of a response that was cut off. */
export function lessonLooksTruncated(markdown: string): boolean {
  return missingLessonSections(markdown).includes('Module Summary');
}

/**
 * Cleans a model's lesson response: strips an all-encompassing ```markdown
 * wrapper, drops any chatty preamble before the first "##" heading, normalises
 * line endings, and closes a code fence left open by a cut-off response.
 */
export function normalizeLessonMarkdown(raw: string | undefined | null): string {
  let text = (raw ?? '').replace(/\r\n/g, '\n').trim();
  const wrapped = text.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n?```\s*$/i);
  if (wrapped) text = wrapped[1].trim();

  const firstHeading = text.search(/^##\s/m);
  if (firstHeading > 0) text = text.slice(firstHeading);

  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) text += '\n```';
  return text.trim();
}

function insideFence(markdown: string, index: number): boolean {
  return ((markdown.slice(0, index).match(/^```/gm) ?? []).length) % 2 === 1;
}

/**
 * Folds extra material into an existing lesson. If the lesson already has its
 * closing "Module Summary", the addition goes in front of it so the chapter
 * still ends with its recap; otherwise it is appended (e.g. a cut-off lesson
 * whose missing tail sections were just written).
 */
export function mergeLessonExpansion(existing: string, addition: string): string {
  const extra = addition.trim();
  if (!extra) return existing;

  const additionHasSummary = /^##\s+.*summary/im.test(withoutFences(extra));
  let summaryAt = -1;
  if (!additionHasSummary) {
    for (const match of existing.matchAll(/^##\s+.*summary.*$/gim)) {
      if (match.index !== undefined && !insideFence(existing, match.index)) summaryAt = match.index;
    }
  }

  if (summaryAt === -1) return `${existing.trimEnd()}\n\n${extra}\n`;
  return `${existing.slice(0, summaryAt).trimEnd()}\n\n${extra}\n\n${existing.slice(summaryAt).trimStart()}`;
}
