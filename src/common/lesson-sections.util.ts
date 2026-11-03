import { stripMarkdownForSpeech } from './tts-text.util';

export interface LessonSection {
  sectionIndex: number;
  title: string; // the "##" heading text, e.g. "Core Concepts"
  markdown: string; // the heading line plus everything under it up to the next "##" heading
}

/**
 * Splits a lesson's markdown into its top-level ("##") sections, so the voice
 * tutor can read ONE heading at a time instead of the whole topic.
 *
 * - "###" sub-headings stay inside their parent section.
 * - A "##" line inside a fenced code block (e.g. a shell comment) is NOT a heading.
 * - Any text before the first "##" becomes an "Introduction" section.
 * - Each section's markdown starts with its own heading, so the tutor says
 *   the heading aloud before reading it.
 * - Sections with nothing speakable in them (e.g. only a code block) are dropped,
 *   so a listener is never given a silent heading to "play".
 */
export function splitLessonIntoSections(markdown: string | undefined | null): LessonSection[] {
  const lines = (markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const raw: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      if (current) raw.push(current);
      current = { title: heading[1].replace(/[*_`]/g, '').trim(), lines: [line] };
    } else {
      if (!current) current = { title: 'Introduction', lines: [] };
      current.lines.push(line);
    }
  }
  if (current) raw.push(current);

  return raw
    .map((s) => ({ title: s.title, markdown: s.lines.join('\n').trim() }))
    .filter((s) => stripMarkdownForSpeech(s.markdown.replace(/^##\s+.+$/m, '')).length > 0)
    .map((s, i) => ({ sectionIndex: i, ...s }));
}
