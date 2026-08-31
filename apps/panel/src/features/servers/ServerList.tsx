import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Gamepad2, MemoryStick, Server } from 'lucide-react';
import { listServers } from './servers.api';
import { Alert, EmptyState, LoadingRow, StatusBadge } from '@/ui/primitives';

const POWER_DOT: Record<string, string> = {
  running: 'bg-ok',
  starting: 'bg-warn',
  stopping: 'bg-warn',
};

export function ServerList({ limit }: { limit?: number } = {}) {
  const { data, isLoading, isError } = useQuery({ queryKey: ['servers'], queryFn: listServers, refetchInterval: 15_000 });

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
              <StatusBadge status={s.status} />
            </div>

            {(s.template || primaryAllocation) && (
              <div className="flex items-center gap-3 text-xs text-text-muted">
                {s.template && (
                  <span className="inline-flex items-center gap-1.5">
                    <Gamepad2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {s.template.name}
                  </span>
                )}
                {primaryAllocation && (
                  <span className="font-mono">
                    {primaryAllocation.ip}:{primaryAllocation.port}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-text-muted">
              <span>{s.node.name}</span>
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
