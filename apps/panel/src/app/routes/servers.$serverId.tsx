import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { RouteTabs, type RouteTab } from '@/ui/primitives';

// Layout for every /servers/$serverId/* page (architecture doc 5.1's
// per-server route group) — provides the breadcrumb + tab nav once, so
// console/files/(later: backups, databases, ...) share one shell instead
// of each re-rendering it. A route file named servers.$serverId.files.tsx
// nests UNDER this one in TanStack Router's flat-file convention; without
// the <Outlet/> below, the child route has nowhere to render at all —
// found live: navigating straight to /servers/:id/files rendered the
// console page instead, silently.
export const Route = createFileRoute('/servers/$serverId')({
  beforeLoad: requireAuth,
  component: ServerLayout,
});

// These stay tabs rather than moving to the sidebar: they are facets of one
// server, not global destinations, and they need the $serverId param.
const TABS: readonly RouteTab[] = [
  { to: '/servers/$serverId', label: 'Console', exact: true },
  { to: '/servers/$serverId/files', label: 'Arquivos' },
  { to: '/servers/$serverId/backups', label: 'Backups' },
  { to: '/servers/$serverId/databases', label: 'Bancos de dados' },
  { to: '/servers/$serverId/schedules', label: 'Agendamentos' },
  { to: '/servers/$serverId/subusers', label: 'Subusuários' },
  { to: '/servers/$serverId/activity', label: 'Atividade' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();

  return (
    <AppShell>
      <Link
        to="/servers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Servidores
      </Link>
      <RouteTabs items={TABS} params={{ serverId }} className="mb-6" />
      <Outlet />
    </AppShell>
  );
}
