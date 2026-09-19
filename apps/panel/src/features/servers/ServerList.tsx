import { useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Copy, Gamepad2, MemoryStick, Server, Settings2 } from 'lucide-react';
import { listServers } from './servers.api';
import { serverStatusLabel } from './status-labels';
import { Alert, EmptyState, LoadingRow, StatusBadge } from '@/ui/primitives';

// A server still in the post-purchase setup flow has no template/software
// chosen yet (`setup_pending`) or is mid-install (`installing`) — showing
// its plan/allocation the way a `ready` card does would be misleading
// (nothing is actually running). These three get the "needs attention"
// treatment instead: an explicit CTA line telling the client what to do
// next, replacing the template/allocation row a `ready` server shows.
const NEEDS_SETUP_CTA: Record<string, string> = {
  setup_pending: 'Configurar servidor',
  install_failed: 'Tentar novamente',
  installing: 'Preparando…',
};

const POWER_DOT: Record<string, string> = {
  running: 'bg-ok',
  starting: 'bg-warn',
  stopping: 'bg-warn',
};

export function ServerList({ limit }: { limit?: number } = {}) {
  const { data, isLoading, isError } = useQuery({ queryKey: ['servers'], queryFn: listServers, refetchInterval: 15_000 });
  // Tracks which card's address was just copied, not a per-card boolean —
  // one shared piece of state is enough since only one click can ever be
  // "the most recent" at a time, and it self-clears so the icon doesn't
  // stay a checkmark forever.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyAddress(e: MouseEvent, serverId: string, address: string) {
    // Every card is itself a <Link> — without this the click would also
    // navigate to the server's own page instead of just copying.
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopiedId(serverId);
      setTimeout(() => setCopiedId((id) => (id === serverId ? null : id)), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // address is already shown as plain selectable text, so this is a
      // silent no-op rather than an error the user can't act on.
    }
  }

  if (isLoading) return <LoadingRow label="Carregando seus servidores…" />;
  if (isError) return <Alert>Não foi possível carregar seus servidores.</Alert>;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="Nenhum servidor ainda"
        description="Quando um servidor for provisionado para você, ele aparece aqui."
      />
    );
  }

  const servers = limit ? data.slice(0, limit) : data;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((s) => {
        const primaryAllocation = s.allocations.find((a) => a.isPrimary) ?? s.allocations[0];
        // Public-exposure plan — a customer never needs to see the
        // internal ip:port once a public one exists; falls back to it
        // unchanged (same as before this feature) when there's none.
        const displayAddress = s.publicAddress ?? (primaryAllocation ? `${primaryAllocation.ip}:${primaryAllocation.port}` : null);
        return (
          <Link
            key={s.id}
            to="/client/servers/$serverId"
            params={{ serverId: s.id }}
            className="group flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-xs transition hover:border-accent/40 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${POWER_DOT[s.powerState] ?? 'bg-text-faint'}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-text transition-colors group-hover:text-accent-strong">{s.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-text-faint">{s.shortId}</p>
                </div>
              </div>
              <StatusBadge status={s.status} label={serverStatusLabel(s.status)} />
            </div>

            {NEEDS_SETUP_CTA[s.status] ? (
              <div className="flex items-center gap-1.5 text-xs font-medium text-accent-strong">
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                {NEEDS_SETUP_CTA[s.status]}
              </div>
            ) : (
              (s.template || displayAddress) && (
                <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                  {s.template && (
                    <span className="inline-flex items-center gap-1.5">
                      <Gamepad2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {s.template.name}
                      {s.minecraftVersion && s.minecraftVersion !== 'latest' && <span>{s.minecraftVersion}</span>}
                    </span>
                  )}
                  {displayAddress && (
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono">{displayAddress}</span>
                      <button
                        type="button"
                        onClick={(e) => void copyAddress(e, s.id, displayAddress)}
                        aria-label="Copiar endereço"
                        title="Copiar endereço"
                        className="rounded p-0.5 text-text-faint transition-colors hover:bg-surface-2 hover:text-text"
                      >
                        {copiedId === s.id ? (
                          <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </span>
                  )}
                </div>
              )
            )}

            <div className="flex items-center justify-end border-t border-border pt-3 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                <MemoryStick className="h-3.5 w-3.5" aria-hidden="true" />
                {s.memoryMb} MB
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
