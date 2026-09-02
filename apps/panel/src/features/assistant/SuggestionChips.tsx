import type { AssistantSuggestion } from '@/shared/api/types';

interface SuggestionChipsProps {
  suggestions: AssistantSuggestion[];
  onPick: (title: string) => void;
  disabled?: boolean;
}

/** Comes straight from GET /suggestions, already filtered server-side by each topic's `requires` — a Fabric server never offers "quero instalar plugins" here. */
export function SuggestionChips({ suggestions, onPick, disabled }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {suggestions.map((s) => (
        <button
          key={s.topicId}
          type="button"
          disabled={disabled}
          onClick={() => onPick(s.title)}
          className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-muted transition hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {s.title}
        </button>
      ))}
    </div>
  );
}
