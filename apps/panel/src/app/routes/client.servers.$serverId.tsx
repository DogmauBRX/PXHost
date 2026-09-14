import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { requireAuth } from '@/app/guards';
import { getServer } from '@/features/servers/servers.api';
import { ServerSetupPage } from '@/features/servers/ServerSetupPage';
import { ServerInstallingPage } from '@/features/servers/ServerInstallingPage';
import { AssistantDrawer } from '@/features/assistant/AssistantDrawer';
import { Card, CardBody, LoadingRow, RouteTabs, type RouteTab } from '@/ui/primitives';

// Pre-ready statuses (setup pós-compra) never render the normal tabs —
// `ServerAccessService.allowedForStatus` already denies every non-`.read`
// action for `setup_pending` server-side, so a customer landing on
// Console/Arquivos/etc. for one of these would just see 403s everywhere
// anyway. `install_failed` reuses the SAME setup screen as
// `setup_pending` (it's also this endpoint's valid retry target — see
// ServerSetupPage's own doc comment), so it isn't listed as its own case.
const SETUP_SCREEN_STATUSES = ['setup_pending', 'install_failed'];

// This route nests under /client in the generated route tree (client.tsx's
// own ClientLayout), which already renders <AppShell>. Wrapping in a
// SECOND <AppShell> here used to double up the whole shell — two Sidebars,
// two Topbars, two theme-toggle buttons, one nested inside the other's
// <main> — found live from a screenshot showing exactly that. Render just
// the page content; the shell is already provided.
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
  { to: '/client/servers/$serverId/subusers', label: 'Subusuários', group: 'avancado' },
  { to: '/client/servers/$serverId/activity', label: 'Atividade', group: 'avancado' },
];

function ServerLayout() {
  const { serverId } = Route.useParams();
  // Same queryKey ['server', serverId] every child page already uses to
  // fetch its own detail — this call is deduped by React Query, not extra.
  // Polls every 5s ONLY while installing — that's the one status this
  // layout expects to change on its own, without any user action, and
  // is what makes ServerInstallingPage give way to the real tabs (or the
  // setup screen again, on failure) with no manual refresh.
  const { data: server, isLoading } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => getServer(serverId),
    refetchInterval: (query) => (query.state.data?.status === 'installing' ? 5000 : false),
  });

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

  const needsSetupScreen = !!server && SETUP_SCREEN_STATUSES.includes(server.status);
  const isInstalling = server?.status === 'installing';

  return (
    <>
      <Link
        to="/client/servers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Meus Servidores
      </Link>
      <Card>
        {isLoading ? (
          <CardBody>
            <LoadingRow />
          </CardBody>
        ) : needsSetupScreen ? (
          <CardBody>
            <ServerSetupPage serverId={serverId} />
          </CardBody>
        ) : isInstalling ? (
          <CardBody>
            <ServerInstallingPage />
          </CardBody>
        ) : (
          <>
            <RouteTabs items={tabs} params={{ serverId }} className="px-4 sm:px-6" />
            <CardBody>
              <Outlet />
            </CardBody>
          </>
        )}
      </Card>
      <AssistantDrawer serverId={serverId} />
    </>
  );
}
