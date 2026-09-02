import { ExternalLink } from 'lucide-react';
import type { AssistantBlock } from '@/shared/api/types';
import { Alert } from '@/ui/primitives';
import { AssistantRouteLink } from './links';

/**
 * A plain `switch` over the typed union — no markdown parser, no
 * `dangerouslySetInnerHTML`. That's deliberate even for today's
 * deterministic KB provider: the block union is also the contract a
 * future LLM adapter has to answer through, and an LLM's output is
 * untrusted text by definition.
 */
export function AssistantBlocks({ blocks, serverId }: { blocks: AssistantBlock[]; serverId: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, i) => (
        <AssistantBlockView key={i} block={block} serverId={serverId} />
      ))}
    </div>
  );
}

function AssistantBlockView({ block, serverId }: { block: AssistantBlock; serverId: string }) {
  switch (block.type) {
    case 'text':
      return <p className="text-sm leading-relaxed text-text">{block.text}</p>;

    case 'steps':
      return (
        <ol className="list-inside list-decimal space-y-1 text-sm leading-relaxed text-text">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );

    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-text">
          <code>{block.code}</code>
        </pre>
      );

    case 'note':
      return (
        <Alert tone={block.tone === 'warn' ? 'warn' : 'info'} className="text-xs">
          {block.text}
        </Alert>
      );

    case 'link':
      return (
        <AssistantRouteLink
          route={block.route}
          serverId={serverId}
          label={block.label}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-tint px-3 py-1.5 text-sm font-medium text-accent-strong transition hover:bg-accent/15"
        />
      );

    case 'external':
      return (
        <a
          href={block.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text transition hover:bg-surface-2"
        >
          {block.label}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      );

    case 'kv':
      return (
        <dl className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2 text-sm">
          {block.items.map((item, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <dt className="text-text-muted">{item.label}</dt>
              <dd className="font-mono font-medium text-text">{item.value}</dd>
            </div>
          ))}
        </dl>
      );
  }
}

