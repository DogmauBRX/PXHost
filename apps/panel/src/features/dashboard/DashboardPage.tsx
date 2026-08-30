import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, HardDrive, MemoryStick, Server, Users } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { listNodes, listAdminServers, listUsers, listAuditLogs } from '@/features/admin/admin.api';
import { ServerList } from '@/features/servers/ServerList';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  StatCard,
} from '@/ui/primitives';

const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  online: 'ok',
  degraded: 'warn',
  offline: 'fail',
  unknown: 'neutral',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h atrás`;
  return `${Math.floor(hours / 24)} d atrás`;
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = Boolean(user?.isAdmin);

  // Every admin query is gated on `isAdmin`. Without this a plain customer
  // loading the dashboard would fire four requests that all come back 403.
  const nodes = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes, enabled: isAdmin });
  const servers = useQuery({ queryKey: ['admin', 'servers'], queryFn: () => listAdminServers(), enabled: isAdmin });
  const users = useQuery({ queryKey: ['admin', 'users', { limit: 1 }], queryFn: () => listUsers({ limit: 1 }), enabled: isAdmin });
  const activity = useQuery({
    queryKey: ['admin', 'audit-logs', { limit: 6 }],
    queryFn: () => listAuditLogs({ limit: 6 }),
    enabled: isAdmin,
  });

  const onlineNodes = nodes.data?.filter((n) => n.healthStatus === 'online').length ?? 0;
  const totalMemoryGb = nodes.data ? Math.round(nodes.data.reduce((sum, n) => sum + n.memoryTotalMb, 0) / 1024) : 0;

  return (
    <>
      <PageHeader
        title={`Olá, ${user?.username ?? 'bem-vindo'}`}
        subtitle={isAdmin ? 'Aqui está um resumo da sua infraestrutura.' : 'Aqui estão os seus servidores.'}
      />

      {isAdmin && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Servidores"
            value={servers.data?.length ?? 0}
            icon={Server}
            tone="accent"
            loading={servers.isPending}
          />
          <StatCard
            label="Nodes"
            value={nodes.data?.length ?? 0}
            icon={HardDrive}
            tone="info"
            loading={nodes.isPending}
            hint={`${onlineNodes} online`}
          />
          <StatCard
            label="Clientes"
            value={users.data?.total ?? 0}
            icon={Users}
            tone="ok"
            loading={users.isPending}
          />
          <StatCard
            label="RAM dos nodes"
            value={`${totalMemoryGb} GB`}
            icon={MemoryStick}
            tone="warn"
            loading={nodes.isPending}
            hint="Capacidade total declarada"
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">Seus servidores</h2>
            <Link to="/servers" className="text-sm font-medium text-accent-strong hover:underline">
              Ver todos
            </Link>
          </div>
          <ServerList limit={6} />
        </div>

        <div className="space-y-6">
          {isAdmin && (
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
          )}

          {isAdmin && (
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
                        <p className="truncate text-xs text-text-faint">
                          {log.actor?.username ?? log.actorEmail ?? 'Sistema'}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-text-faint">{relativeTime(log.occurredAt)}</span>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
