import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listServers } from './servers.api';
import { StatusBadge } from '@/ui/primitives/Badge';

export function ServerList() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['servers'], queryFn: listServers, refetchInterval: 15_000 });

  if (isLoading) {
    return <p className="text-sm text-text-muted">Carregando seus servidores…</p>;
  }
  if (isError) {
    return <p className="text-sm text-fail">Não foi possível carregar seus servidores.</p>;
  }
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-text-muted">
        Você ainda não tem nenhum servidor.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((s) => (
        <Link
          key={s.id}
          to="/servers/$serverId"
          params={{ serverId: s.id }}
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm transition-colors hover:border-border-strong"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-text">{s.name}</p>
              <p className="font-mono text-xs text-text-faint">{s.shortId}</p>
            </div>
            <StatusBadge status={s.status} />
          </div>
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>{s.node.name}</span>
            <span className="font-mono">{s.memoryMb} MB</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
