import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { RouteTabs, type RouteTab } from '@/ui/primitives';

// Mirrors the old servers.$serverId.tsx layout exactly, just re-homed under
// /client. Without the <Outlet/> below, a child route has nowhere to
// render — found live once already when this nesting first shipped.
export const Route = createFileRoute('/client/servers/$serverId')({
  beforeLoad: requireAuth,
  component: ServerLayout,
});

const TABS: readonly RouteTab[] = [
  { to: '/client/servers/$serverId', label: 'Console', exact: true },
  { to: '/client/servers/$serverId/files', label: 'Arquivos' },
  { to: '/client/servers/$serverId/backups', label: 'Backups' },
  { to: '/client/servers/$serverId/databases', label: 'Bancos de dados' },
  { to: '/client/servers/$serverId/schedules', label: 'Agendamentos' },
  { to: '/client/servers/$serverId/subusers', label: 'Subusuários' },
  { to: '/client/servers/$serverId/activity', label: 'Atividade' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();

  return (
    <AppShell area="client">
      <Link
        to="/client/servers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Meus Servidores
      </Link>
      <RouteTabs items={TABS} params={{ serverId }} className="mb-6" />
      <Outlet />
    </AppShell>
  );
}
