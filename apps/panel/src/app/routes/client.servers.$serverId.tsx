import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { getServer } from '@/features/servers/servers.api';
import { AssistantDrawer } from '@/features/assistant/AssistantDrawer';
import { RouteTabs, type RouteTab } from '@/ui/primitives';

// Mirrors the old servers.$serverId.tsx layout exactly, just re-homed under
// /client. Without the <Outlet/> below, a child route has nowhere to
// render — found live once already when this nesting first shipped.
export const Route = createFileRoute('/client/servers/$serverId')({
  beforeLoad: requireAuth,
  component: ServerLayout,
});

// "Somar e agrupar" (client-features Fase 7): nothing removed from the
// M7-era flat list, just clustered into Básico/Avançado so the tab bar
// scales past 7 items without every tab reading as equally important.
const BASIC_TABS: readonly RouteTab[] = [
  { to: '/client/servers/$serverId', label: 'Console', exact: true, group: 'basico' },
  { to: '/client/servers/$serverId/files', label: 'Arquivos', group: 'basico' },
  { to: '/client/servers/$serverId/backups', label: 'Backups', group: 'basico' },
  { to: '/client/servers/$serverId/variables', label: 'Configurações', group: 'basico' },
];
const ADVANCED_TABS: readonly RouteTab[] = [
  { to: '/client/servers/$serverId/databases', label: 'Bancos de dados', group: 'avancado' },
  { to: '/client/servers/$serverId/schedules', label: 'Agendamentos', group: 'avancado' },
  { to: '/client/servers/$serverId/subusers', label: 'Subusuários', group: 'avancado' },
  { to: '/client/servers/$serverId/activity', label: 'Atividade', group: 'avancado' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();
  // Same queryKey ['server', serverId] every child page already uses to
  // fetch its own detail — this call is deduped by React Query, not extra.
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });

  // A server is plugins OR mods, never both — the tab simply doesn't exist
  // for vanilla/other/unclassified software, rather than opening onto an
  // empty page.
  const basicTabs: RouteTab[] = server?.software.addonDir
    ? [
        ...BASIC_TABS.slice(0, 2),
        { to: '/client/servers/$serverId/addons', label: server.software.addonLabel ?? 'Add-ons', group: 'basico' },
        ...BASIC_TABS.slice(2),
      ]
    : [...BASIC_TABS];
  const tabs: RouteTab[] = [...basicTabs, ...ADVANCED_TABS];

  return (
    <AppShell area="client">
      <Link
        to="/client/servers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Meus Servidores
      </Link>
      <RouteTabs items={tabs} params={{ serverId }} className="mb-6" />
      <Outlet />
      <AssistantDrawer serverId={serverId} />
    </AppShell>
  );
}
