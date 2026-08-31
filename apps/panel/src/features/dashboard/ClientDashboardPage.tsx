import { useQuery } from '@tanstack/react-query';
import { Power, Server } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { listServers } from '@/features/servers/servers.api';
import { ServerList } from '@/features/servers/ServerList';
import { PageHeader, StatCard } from '@/ui/primitives';

/**
 * The customer's own view — mounted at `/client`, deliberately much simpler
 * than the operator dashboard. No infrastructure-wide numbers (nodes,
 * other clients): a customer's world is exactly their own servers.
 *
 * Shows capacity (allocated memory/disk/CPU) rather than live usage bars —
 * `listServers()` only carries allocated limits, not a usage snapshot;
 * live usage exists only per-server over the console's WebSocket, and
 * opening N of those from a dashboard grid nobody's actively watching
 * isn't a cost worth paying for a number that's stale the moment you
 * navigate away. See ServerList's cards for what's actually shown.
 */
export function ClientDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery({ queryKey: ['servers'], queryFn: listServers, refetchInterval: 15_000 });

  const total = data?.length ?? 0;
  const online = data?.filter((s) => s.powerState === 'running').length ?? 0;

  return (
    <>
      <PageHeader title={`Olá, ${user?.username ?? 'bem-vindo'}`} subtitle="Aqui está o status dos seus servidores." />

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Servidores" value={total} icon={Server} tone="accent" />
        <StatCard label="Online" value={online} icon={Power} tone="ok" />
      </div>

      <ServerList />
    </>
  );
}
