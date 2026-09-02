import { Bot, User } from 'lucide-react';
import type { AssistantBlock } from '@/shared/api/types';
import { AssistantBlocks } from './AssistantBlocks';

interface ChatBubbleProps {
  role: 'user' | 'assistant';
  /** User messages are plain text; assistant messages render the typed block union. */
  text?: string;
  blocks?: AssistantBlock[];
  serverId: string;
}

/** No existing chat primitive in this codebase — genuinely new, stays in features/assistant/ unless a second consumer shows up. */
export function ChatBubble({ role, text, blocks, serverId }: ChatBubbleProps) {
  const isUser = role === 'user';
  return (
    <div className={`flex items-start gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-accent text-white' : 'bg-accent-tint text-accent-strong'}`}
      >
        {isUser ? <User className="h-3.5 w-3.5" aria-hidden="true" /> : <Bot className="h-3.5 w-3.5" aria-hidden="true" />}
      </span>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
          isUser ? 'rounded-tr-sm bg-accent text-white' : 'rounded-tl-sm bg-surface-2 text-text'
        }`}
      >
        {isUser ? <p className="text-sm leading-relaxed">{text}</p> : <AssistantBlocks blocks={blocks ?? []} serverId={serverId} />}
      </div>
    </div>
  );
}
