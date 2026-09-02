import { useQuery } from '@tanstack/react-query';
import { Power, Server } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { listServers } from '@/features/servers/servers.api';
import { listClientPlans } from '@/features/client/plans.api';
import { ServerList } from '@/features/servers/ServerList';
import { PlanRecommendationCard } from '@/features/client/PlanRecommendationCard';
import { UpsellCard } from '@/features/client/UpsellCard';
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
  // Only needed to size the upsell — cheap, public, and shared with /client/plan's own query cache.
  const { data: plans } = useQuery({ queryKey: ['client-plans'], queryFn: listClientPlans, staleTime: 60_000 });

  const total = data?.length ?? 0;
  const online = data?.filter((s) => s.powerState === 'running').length ?? 0;

  // The dashboard spans potentially several servers on several plans — no
  // single "the" plan to show a recommendation for. Pick the most common
  // one among the customer's servers, which is right for the overwhelming
  // majority of accounts (one plan, one or a few servers) without pretending
  // there's a single answer when there genuinely isn't.
  const primaryServer = mostCommonPlanServer(data ?? []);

  return (
    <>
      <PageHeader title={`Olá, ${user?.username ?? 'bem-vindo'}`} subtitle="Aqui está o status dos seus servidores." />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Servidores" value={total} icon={Server} tone="accent" />
        <StatCard label="Online" value={online} icon={Power} tone="ok" />
      </div>

      {primaryServer?.plan && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PlanRecommendationCard planName={primaryServer.plan.name} memoryMb={primaryServer.memoryMb} plan={primaryServer.plan} />
          {plans && <UpsellCard currentPlan={primaryServer.plan} plans={plans} />}
        </div>
      )}

      <ServerList />
    </>
  );
}

function mostCommonPlanServer<T extends { plan: { id: string } | null }>(servers: T[]): T | undefined {
  if (servers.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const s of servers) {
    if (!s.plan) continue;
    counts.set(s.plan.id, (counts.get(s.plan.id) ?? 0) + 1);
  }
  if (counts.size === 0) return servers[0];
  const topPlanId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return servers.find((s) => s.plan?.id === topPlanId);
}
