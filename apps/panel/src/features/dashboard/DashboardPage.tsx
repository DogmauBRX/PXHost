import { useQuery } from '@tanstack/react-query';
import { Activity, HardDrive, MemoryStick, Server, Users } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { getCapacityDashboard, listNodes, listUsers, listAuditLogs } from '@/features/admin/admin.api';
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, StatCard } from '@/ui/primitives';

const CAPACITY_TONE: Record<'normal' | 'warning' | 'critical', 'ok' | 'warn' | 'fail'> = {
  normal: 'ok',
  warning: 'warn',
  critical: 'fail',
};

const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  online: 'ok',
  degraded: 'warn',
  offline: 'fail',
  unknown: 'neutral',
};

function worstStatus(statuses: ('normal' | 'warning' | 'critical')[]): 'normal' | 'warning' | 'critical' {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'normal';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h atrás`;
  return `${Math.floor(hours / 24)} d atrás`;
}

/** The operator's view of the whole platform — mounted at `/admin`, admin-only. The customer's equivalent is `ClientDashboardPage`, mounted at `/client`. */
export function DashboardPage() {
  const user = useAuthStore((s) => s.user);

  const nodes = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });
  const capacity = useQuery({ queryKey: ['admin', 'capacity', 'dashboard'], queryFn: getCapacityDashboard });
  const users = useQuery({ queryKey: ['admin', 'users', { limit: 1 }], queryFn: () => listUsers({ limit: 1 }) });
  const activity = useQuery({ queryKey: ['admin', 'audit-logs', { limit: 8 }], queryFn: () => listAuditLogs({ limit: 8 }) });

  // Real, from `/api/admin/capacity` — replaces what used to be a
  // client-side sum of `node.memoryTotalMb` (labeled "capacidade total
  // declarada"), which ignored reserve/overallocate entirely and never
  // showed how much of that capacity was actually allocated.
  const memoryGb = capacity.data ? Math.round(capacity.data.memory.commercial / 1024) : 0;
  const memoryUsedPct = capacity.data && capacity.data.memory.commercial > 0 ? Math.round((capacity.data.memory.allocated / capacity.data.memory.commercial) * 100) : 0;
  const memoryStatus = capacity.data ? worstStatus(capacity.data.perNode.map((n) => n.memory.status)) : 'normal';

  return (
    <>
      <PageHeader title={`Olá, ${user?.username ?? 'Admin'}`} subtitle="Aqui está um resumo da sua infraestrutura." />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Servidores" value={capacity.data?.servers.total ?? 0} icon={Server} tone="accent" loading={capacity.isPending} hint={capacity.data ? `${capacity.data.servers.active} ativos` : undefined} />
        <StatCard
          label="Nodes"
          value={capacity.data?.nodes.total ?? nodes.data?.length ?? 0}
          icon={HardDrive}
          tone="info"
          loading={capacity.isPending}
          hint={capacity.data ? `${capacity.data.nodes.online} online` : undefined}
        />
        <StatCard label="Clientes" value={users.data?.total ?? 0} icon={Users} tone="ok" loading={users.isPending} />
        <StatCard
          label="RAM dos nodes"
          value={`${memoryGb} GB`}
          icon={MemoryStick}
          tone={CAPACITY_TONE[memoryStatus]}
          loading={capacity.isPending}
          hint={`${memoryUsedPct}% alocado${capacity.data?.memory.commercialIsFloor ? ' · pelo menos' : ' da capacidade comercial'}`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status dos nodes</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 p-4">
            {nodes.isPending ? (
              <p className="text-sm text-text-muted">Carregando…</p>
            ) : !nodes.data || nodes.data.length === 0 ? (
              <p className="text-sm text-text-muted">Nenhum node cadastrado.</p>
            ) : (
              nodes.data.slice(0, 6).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{n.name}</p>
                    <p className="truncate text-xs text-text-faint">{n.fqdn}</p>
                  </div>
                  <Badge tone={HEALTH_TONE[n.healthStatus] ?? 'neutral'}>{n.healthStatus}</Badge>
                </div>
              ))
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Atividade recente</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 p-4">
            {activity.isPending ? (
              <p className="text-sm text-text-muted">Carregando…</p>
            ) : !activity.data || activity.data.items.length === 0 ? (
              <EmptyState icon={Activity} title="Sem atividade" />
            ) : (
              activity.data.items.map((log) => (
                <div key={log.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-text">{log.action}</p>
                    <p className="truncate text-xs text-text-faint">{log.actor?.username ?? log.actorEmail ?? 'Sistema'}</p>
                  </div>
                  <span className="shrink-0 text-xs text-text-faint">{relativeTime(log.occurredAt)}</span>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
