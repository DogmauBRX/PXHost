import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { requireAdmin } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';

// Layout for every /admin/* page (architecture doc roadmap M12) — mirrors
// the per-server layout route's own Console/Arquivos/... tab nav
// (servers.$serverId.tsx), just gated by requireAdmin instead of
// requireAuth and with a different tab set.
export const Route = createFileRoute('/admin')({
  beforeLoad: requireAdmin,
  component: AdminLayout,
});

const TABS = [
  { to: '/admin', label: 'Locations' },
  { to: '/admin/nodes', label: 'Nodes' },
  { to: '/admin/templates', label: 'Templates' },
  { to: '/admin/plans', label: 'Plans' },
  { to: '/admin/servers', label: 'Servers' },
] as const;

function AdminLayout() {
  const matchRoute = useMatchRoute();

  return (
    <AppShell>
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-text-muted hover:text-text">
            ← Painel
          </Link>
          <div className="h-4 w-px bg-border" />
          <nav className="flex items-center gap-1">
            {TABS.map((tab) => {
              const active = Boolean(matchRoute({ to: tab.to, fuzzy: tab.to === '/admin' ? false : undefined }));
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
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
