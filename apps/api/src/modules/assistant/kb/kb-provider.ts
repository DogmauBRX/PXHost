import { Injectable } from '@nestjs/common';
import type { AssistantContext, AssistantMessage, AssistantProvider, AssistantReply, AssistantSuggestion } from '../assistant.types';
import { KB_TOPICS, type KbTopic } from './kb-topics';
import { scoreAgainstKeywords, tokenize } from './kb-matcher';

// Below this, the best-scoring topic is more likely a coincidental token
// overlap than a real match — "não tenho certeza" is the correct answer,
// not a guess. Tuned by hand against the topic list above, not derived.
const MATCH_THRESHOLD = 0.5;
const FALLBACK_SUGGESTION_COUNT = 3;

/**
 * The default, always-available AssistantProvider (assistant.module.ts's
 * provider factory picks this whenever ASSISTANT_PROVIDER isn't 'llm', or
 * 'llm' was requested without a key). Deterministic and stateless: the
 * same message + context always produces the same reply, and nothing
 * here reaches Redis, the database, or the agent — see KbTopic's own doc
 * comment on `requires` for why an incompatible answer is structurally
 * impossible rather than merely unlikely.
 */
@Injectable()
export class KnowledgeBaseProvider implements AssistantProvider {
  readonly id = 'kb' as const;

  private eligibleTopics(ctx: AssistantContext): KbTopic[] {
    return KB_TOPICS.filter((t) => !t.requires || t.requires(ctx));
  }

  private bestMatch(message: string, ctx: AssistantContext): { topic: KbTopic; score: number } | null {
    const queryTokens = tokenize(message);
    if (queryTokens.length === 0) return null;

    let best: { topic: KbTopic; score: number } | null = null;
    for (const topic of this.eligibleTopics(ctx)) {
      const score = scoreAgainstKeywords(queryTokens, topic.keywords);
      if (score > (best?.score ?? 0)) best = { topic, score };
    }
    return best;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- satisfies AssistantProvider's async contract, same shape a future LLM adapter needs
  async reply(message: string, _history: AssistantMessage[], ctx: AssistantContext): Promise<AssistantReply> {
    const match = this.bestMatch(message, ctx);
    if (!match || match.score < MATCH_THRESHOLD) {
      return this.fallback(ctx);
    }
    return { blocks: match.topic.render(ctx), topicId: match.topic.id, confident: true };
  }

  private fallback(ctx: AssistantContext): AssistantReply {
    const suggestions = this.suggestions(ctx).slice(0, FALLBACK_SUGGESTION_COUNT);
    return {
      confident: false,
      blocks: [
        { type: 'text', text: 'Não tenho certeza sobre isso. Aqui estão alguns tópicos que talvez ajudem, ou fale com o suporte.' },
        { type: 'steps', items: suggestions.map((s) => s.title) },
        { type: 'link', route: 'client.support', label: 'Falar com o suporte' },
      ],
    };
  }

  /** Every topic this server's context makes eligible — GET /suggestions and the fallback reply both read from here, so they can never disagree about what's offered. */
  suggestions(ctx: AssistantContext): AssistantSuggestion[] {
    return this.eligibleTopics(ctx).map((t) => ({ topicId: t.id, title: t.title }));
  }
}
