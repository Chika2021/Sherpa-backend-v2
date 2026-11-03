/**
 * Turns generated markdown into plain text that reads naturally aloud.
 *
 * Every character that survives this function is billed against the TTS quota,
 * so it also drops everything that would be useless or awkward to hear: code
 * blocks, raw URLs, HTML, emoji, horizontal rules, table scaffolding and image
 * syntax. Shared by anything that turns generated content into speech
 * (AudioService).
 */
export function stripMarkdownForSpeech(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks are not useful spoken aloud - drop entirely
    .replace(/<[^>]+>/g, ' ') // stray HTML tags
    .replace(/!\[[^\]]*]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1') // links -> just the link text
    .replace(/\bhttps?:\/\/\S+/gi, ' ') // bare URLs are unpleasant to hear spelled out
    .replace(/`([^`]+)`/g, '$1') // inline code -> its text
    .replace(/^\s{0,3}([-*_=]\s*){3,}$/gm, ' ') // horizontal rules / setext underlines
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ') // table separator rows like |---|:--:|
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '') // "1. " list numbering
    .replace(/[*_~>#]/g, '')
    .replace(/\|/g, ' ') // table pipes
    .replace(/\p{Extended_Pictographic}|[\u200d\ufe0f]/gu, '') // emoji
    .replace(/([.!?:;])[ \t]*\n{2,}/g, '$1 ') // paragraph break after punctuation: no extra ". "
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
