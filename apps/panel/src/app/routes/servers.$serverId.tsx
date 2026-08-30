import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';

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

const TABS = [
  { to: '/servers/$serverId', label: 'Console' },
  { to: '/servers/$serverId/files', label: 'Arquivos' },
  { to: '/servers/$serverId/backups', label: 'Backups' },
  { to: '/servers/$serverId/databases', label: 'Bancos de dados' },
  { to: '/servers/$serverId/schedules', label: 'Agendamentos' },
  { to: '/servers/$serverId/subusers', label: 'Subusuários' },
  { to: '/servers/$serverId/activity', label: 'Atividade' },
] as const;

function ServerLayout() {
  const { serverId } = Route.useParams();
  const matchRoute = useMatchRoute();

  return (
    <AppShell>
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-text-muted hover:text-text">
            ← Servidores
          </Link>
          <div className="h-4 w-px bg-border" />
          <nav className="flex items-center gap-1">
            {TABS.map((tab) => {
              const active = Boolean(matchRoute({ to: tab.to, params: { serverId }, fuzzy: tab.to === '/servers/$serverId' ? false : undefined }));
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
                  params={{ serverId }}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active ? 'bg-accent-tint text-accent-strong' : 'text-text-muted hover:text-text'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
