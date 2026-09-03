import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, User } from 'lucide-react';
import { requireAdmin } from '@/app/guards';
import { getAdminServer } from '@/features/admin/admin.api';
import { getServer } from '@/features/servers/servers.api';
import { Card, CardBody, RouteTabs, StatusBadge, type RouteTab } from '@/ui/primitives';

// The admin drill-down mirrors client.servers.$serverId.tsx's shape exactly
// — same tabs, same page components underneath — but adds an owner-context
// banner up top, and every tab's underlying API call reaches this server
// via ServerAccessService's admin bypass (see server-access.service.ts's
// `resolve()`), not through ownership. AuthenticatedUser.isAdmin is what
// lets the SAME /api/client/servers/:id/* routes serve this page too;
// there is no separate admin-only files/backups/etc. API surface.
//
// This route nests under /admin (admin.tsx's own <AppShell>) — it must
// NOT wrap in a second one itself. It used to, which doubled the whole
// shell (two Sidebars, two Topbars, two theme-toggle buttons) — the exact
// bug already found and fixed on the client side
// (client.servers.$serverId.tsx).
export const Route = createFileRoute('/admin/servers/$serverId')({
  beforeLoad: requireAdmin,
  component: ServerLayout,
});

// "Somar e agrupar" (client-features Fase 7) — see the identical comment
// in client.servers.$serverId.tsx, which this mirrors tab-for-tab.
const BASIC_TABS: readonly RouteTab[] = [
  { to: '/admin/servers/$serverId', label: 'Console', exact: true, group: 'basico' },
  { to: '/admin/servers/$serverId/files', label: 'Arquivos', group: 'basico' },
  { to: '/admin/servers/$serverId/backups', label: 'Backups', group: 'basico' },
  { to: '/admin/servers/$serverId/variables', label: 'Configurações', group: 'basico' },
];
const ADVANCED_TABS: readonly RouteTab[] = [
  { to: '/admin/servers/$serverId/databases', label: 'Bancos de dados', group: 'avancado' },
  { to: '/admin/servers/$serverId/schedules', label: 'Agendamentos', group: 'avancado' },
  { to: '/admin/servers/$serverId/subusers', label: 'Subusuários', group: 'avancado' },
  { to: '/admin/servers/$serverId/activity', label: 'Atividade', group: 'avancado' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();
  const { data: server } = useQuery({ queryKey: ['admin', 'server', serverId], queryFn: () => getAdminServer(serverId) });
  // AdminServerDetail (above) carries owner/plan for the banner, not
  // software — that comes from the same /api/client/servers/:id the client
  // side uses, reachable here too via the admin bypass in resolve().
  const { data: clientServer } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const basicTabs: RouteTab[] = clientServer?.software.addonDir
    ? [
        ...BASIC_TABS.slice(0, 2),
        { to: '/admin/servers/$serverId/addons', label: clientServer.software.addonLabel ?? 'Add-ons', group: 'basico' },
        ...BASIC_TABS.slice(2),
      ]
    : [...BASIC_TABS];
  const tabs: RouteTab[] = [...basicTabs, ...ADVANCED_TABS];

  return (
    <>
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

      <Card>
        <RouteTabs items={tabs} params={{ serverId }} className="px-4 sm:px-6" />
        <CardBody>
          <Outlet />
        </CardBody>
      </Card>
    </>
  );
}
