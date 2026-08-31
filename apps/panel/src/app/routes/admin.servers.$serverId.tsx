import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, User } from 'lucide-react';
import { requireAdmin } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { getAdminServer } from '@/features/admin/admin.api';
import { RouteTabs, StatusBadge, type RouteTab } from '@/ui/primitives';

// The admin drill-down mirrors client.servers.$serverId.tsx's shape exactly
// — same tabs, same page components underneath — but adds an owner-context
// banner up top, and every tab's underlying API call reaches this server
// via ServerAccessService's admin bypass (see server-access.service.ts's
// `resolve()`), not through ownership. AuthenticatedUser.isAdmin is what
// lets the SAME /api/client/servers/:id/* routes serve this page too;
// there is no separate admin-only files/backups/etc. API surface.
export const Route = createFileRoute('/admin/servers/$serverId')({
  beforeLoad: requireAdmin,
  component: ServerLayout,
});

const TABS: readonly RouteTab[] = [
  { to: '/admin/servers/$serverId', label: 'Console', exact: true },
  { to: '/admin/servers/$serverId/files', label: 'Arquivos' },
  { to: '/admin/servers/$serverId/backups', label: 'Backups' },
  { to: '/admin/servers/$serverId/databases', label: 'Bancos de dados' },
  { to: '/admin/servers/$serverId/schedules', label: 'Agendamentos' },
  { to: '/admin/servers/$serverId/subusers', label: 'Subusuários' },
  { to: '/admin/servers/$serverId/activity', label: 'Atividade' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();
  const { data: server } = useQuery({ queryKey: ['admin', 'server', serverId], queryFn: () => getAdminServer(serverId) });

  return (
    <AppShell area="admin">
      <Link
        to="/admin/servers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Todos os servidores
      </Link>

      {server && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-tint text-accent-strong">
              <User className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium text-text">{server.name}</p>
              <p className="text-xs text-text-faint">
                Cliente: {server.owner?.username ?? '—'} · Plano: {server.plan?.name ?? '—'} · Node: {server.node.name}
              </p>
            </div>
          </div>
          <StatusBadge status={server.status} />
        </div>
      )}

      <RouteTabs items={TABS} params={{ serverId }} className="mb-6" />
      <Outlet />
    </AppShell>
  );
}
