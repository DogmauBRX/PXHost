import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { getAssistantSuggestions, sendAssistantMessage } from './assistant.api';
import { ChatBubble } from './ChatBubble';
import { SuggestionChips } from './SuggestionChips';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Input } from '@/ui/primitives';
import type { AssistantBlock, AssistantMessage } from '@/shared/api/types';

interface ChatEntry {
  role: 'user' | 'assistant';
  text?: string;
  blocks?: AssistantBlock[];
}

/** Flattens a reply's blocks into plain text for the wire-format `history` the API accepts — the KB provider ignores history entirely, so this only has to be good enough for a future LLM adapter's context, not a lossless transcript. */
function blocksToPlainText(blocks: AssistantBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
        case 'note':
          return b.text;
        case 'steps':
          return b.items.join(' ');
        case 'code':
          return b.code;
        case 'link':
        case 'external':
          return b.label;
        case 'kv':
          return b.items.map((i) => `${i.label}: ${i.value}`).join(' ');
      }
    })
    .join(' ');
}

/**
 * The reusable widget both the floating drawer (AssistantDrawer, mounted
 * on every server page) and the standalone /client/assistant route embed.
 * Conversation is stateless server-side (Fase 8's design) — this
 * component's own `entries` state IS the transcript; nothing is persisted
 * across a reload.
 */
export function AssistantChat({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: suggestions } = useQuery({
    queryKey: ['assistant-suggestions', serverId],
    queryFn: () => getAssistantSuggestions(serverId),
  });

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const history: AssistantMessage[] = entries.map((e) => ({ role: e.role, text: e.text ?? blocksToPlainText(e.blocks ?? []) }));
    setEntries((prev) => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setError(null);
    setSending(true);
    scrollToBottom();

    try {
      const reply = await sendAssistantMessage(serverId, trimmed, history);
      setEntries((prev) => [...prev, { role: 'assistant', blocks: reply.blocks }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não consegui responder agora. Tente de novo em instantes.');
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-2">
        {entries.length === 0 ? (
          <div className="flex flex-col gap-3">
            <ChatBubble
              role="assistant"
              serverId={serverId}
              blocks={[{ type: 'text', text: 'Oi! Sou o assistente PXHOST 🤖 Posso ajudar com o dia a dia do seu servidor — instalar mods/plugins, backups, configurações e mais. O que você quer fazer?' }]}
            />
            <SuggestionChips suggestions={suggestions ?? []} onPick={(title) => void send(title)} disabled={sending} />
          </div>
        ) : (
          entries.map((entry, i) => <ChatBubble key={i} role={entry.role} text={entry.text} blocks={entry.blocks} serverId={serverId} />)
        )}
        {sending && <ChatBubble role="assistant" serverId={serverId} blocks={[{ type: 'text', text: 'Digitando…' }]} />}
      </div>

      {error && (
        <Alert className="mx-1 mb-2" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="flex shrink-0 gap-2 border-t border-border px-1 pt-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pergunte algo sobre seu servidor…"
          disabled={sending}
          className="flex-1"
        />
        <Button type="submit" variant="primary" disabled={sending || !input.trim()}>
          <Send className="h-4 w-4" aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
