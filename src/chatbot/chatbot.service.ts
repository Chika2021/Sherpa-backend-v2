import { Injectable, Logger } from '@nestjs/common';
import { CerebrasService } from '../ai/cerebras.service';
import { TokensService } from '../tokens/tokens.service';
import { FREE_SIGNUP_TOKENS } from '../tokens/token-pricing.config';
import { ChatTurnDto } from './chatbot.dto';
import { KNOWLEDGE, KnowledgeTopic, QUICK_SUGGESTIONS } from './chatbot.knowledge';

export interface ChatReply {
  reply: string;
  links: Array<{ label: string; path: string }>;
  suggestions: string[];
  /** True when the chat should offer to open a human support ticket. */
  handoff: boolean;
  source: 'rules' | 'ai' | 'fallback';
}

const HANDOFF_RE = /\b(human|person|agent|someone|representative|real person|support team|talk to (a|an)? ?(human|person)|contact (you|us|support)|complain|helpdesk|help desk|ticket|speak to)\b/i;
const GREETING_RE = /^(hi|hello|hey|hola|good (morning|afternoon|evening)|yo|sup|howdy)\b/i;
const THANKS_RE = /^(thanks|thank you|thx|cheers|great|ok(ay)?|cool|nice)\b/i;

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private cerebras: CerebrasService,
    private tokens: TokensService,
  ) {}

  async reply(message: string, history: ChatTurnDto[] = []): Promise<ChatReply> {
    const text = message.trim();

    if (HANDOFF_RE.test(text)) {
      return {
        reply:
          "I can pass this to our support team. Open a helpdesk ticket and a real person will reply - you'll get the answer in your Helpdesk inbox (and by email).",
        links: [],
        suggestions: [],
        handoff: true,
        source: 'rules',
      };
    }
    if (GREETING_RE.test(text) && text.split(/\s+/).length <= 4) {
      return {
        reply: "Hi! I'm the Sherpar assistant. I can show you around the app, explain tokens and pricing, or help with a problem. What do you need?",
        links: [],
        suggestions: QUICK_SUGGESTIONS,
        handoff: false,
        source: 'rules',
      };
    }
    if (THANKS_RE.test(text) && text.split(/\s+/).length <= 4) {
      return { reply: "You're welcome! Anything else I can help with?", links: [], suggestions: QUICK_SUGGESTIONS, handoff: false, source: 'rules' };
    }

    const ranked = this.rank(text);
    const best = ranked[0];

    // Confident keyword match: answer straight from the knowledge base - instant, free and accurate.
    if (best && best.score >= 3) return this.fromTopic(best.topic, 'rules');

    // Otherwise let the AI answer, grounded ONLY in our knowledge base.
    try {
      const aiText = await this.askAi(text, history);
      if (aiText) {
        return {
          reply: aiText,
          links: this.linksFor(ranked.slice(0, 2).map((r) => r.topic)),
          suggestions: [],
          handoff: /ticket|support team|helpdesk/i.test(aiText),
          source: 'ai',
        };
      }
    } catch (err) {
      this.logger.warn(`Chatbot AI unavailable, using fallback: ${(err as Error).message}`);
    }

    if (best && best.score >= 1) return this.fromTopic(best.topic, 'fallback');
    return {
      reply: "I'm not sure about that one. Try rephrasing, pick a topic below, or open a support ticket and a person will help.",
      links: [],
      suggestions: [...QUICK_SUGGESTIONS.slice(0, 3)],
      handoff: true,
      source: 'fallback',
    };
  }

  // ---------- internals ----------

  private rank(text: string): Array<{ topic: KnowledgeTopic; score: number }> {
    const q = ` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ')} `;
    return KNOWLEDGE.map((topic) => {
      let score = 0;
      for (const kw of topic.keywords) {
        const k = kw.toLowerCase();
        if (q.includes(` ${k} `)) score += k.includes(' ') ? 4 : 3; // whole word / phrase
        else if (!k.includes(' ') && k.length > 4 && q.includes(k)) score += 1; // partial (plurals etc.)
      }
      return { topic, score };
    })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private fromTopic(topic: KnowledgeTopic, source: ChatReply['source']): ChatReply {
    return {
      reply: this.fill(topic.answer),
      links: this.linksFor([topic]),
      suggestions: [],
      handoff: false,
      source,
    };
  }

  private linksFor(topics: KnowledgeTopic[]) {
    return topics.filter((t) => t.path).map((t) => ({ label: t.linkLabel || t.title, path: t.path! }));
  }

  private fill(answer: string): string {
    if (!answer.includes('{pricing}')) return answer;
    const p = this.tokens.pricing();
    const pricing = `$${p.bundlePriceUsd} buys ${p.bundleTokens} tokens and one AI generation costs 1 token (new accounts get ${FREE_SIGNUP_TOKENS} free).`;
    return answer.replace('{pricing}', pricing);
  }

  private async askAi(text: string, history: ChatTurnDto[]): Promise<string | null> {
    const kb = KNOWLEDGE.map((t) => `- ${t.title}: ${this.fill(t.answer)}`).join('\n');
    const convo = history
      .slice(-6)
      .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`)
      .join('\n');

    const prompt = [
      'You are the friendly in-app assistant for "Sherpar", a job-application and career app.',
      'Answer ONLY using the knowledge below. Be concise (max 3 short sentences), plain text, no markdown.',
      'If the answer is not in the knowledge, say you are not sure and suggest opening a support ticket so the team can help.',
      'Never invent features, prices, links or policies. Never ask for passwords or payment details.',
      '',
      'KNOWLEDGE:',
      kb,
      '',
      convo ? `CONVERSATION SO FAR:\n${convo}\n` : '',
      `User: ${text}`,
      'Assistant:',
    ].join('\n');

    const out = await this.cerebras.generateText(prompt, 15_000, 300);
    const clean = out?.replace(/^assistant:\s*/i, '').trim();
    return clean ? clean.slice(0, 900) : null;
  }
}
