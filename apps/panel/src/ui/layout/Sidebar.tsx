import { useEffect } from 'react';
import { Link, useMatchRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import type { LinkProps } from '@tanstack/react-router';
import { LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useUiStore } from '@/shared/stores/ui.store';
import { logout } from '@/features/auth/auth.api';
import { Avatar } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';
import type { NavItem, NavSection } from './nav.config';

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to: item.to, fuzzy: item.exact ? false : undefined } as never));
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-accent-tint font-medium text-accent-strong'
          : 'text-text-muted hover:bg-surface-2 hover:text-text'
      }`}
    >
      {active && <span className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent" />}
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

interface SidebarProps {
  sections: readonly NavSection[];
  panelLabel: string;
  settingsTo: LinkProps['to'];
}

export function Sidebar({ sections, panelLabel, settingsTo }: SidebarProps) {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Close the mobile drawer whenever the route changes, so tapping an item
  // doesn't leave the overlay covering the page it just opened.
  useEffect(() => {
    closeSidebar();
  }, [pathname, closeSidebar]);

  async function handleLogout() {
    try {
      await logout();
    } finally {
      clear();
      void navigate({ to: '/login' });
    }
  }

  return (
    <>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface transition-transform duration-200 motion-reduce:transition-none lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="sidebar-brand flex h-20 shrink-0 flex-col justify-center gap-1 border-b border-border px-5">
          <CircuitPattern className="sidebar-brand__circuit" />
          <div className="relative flex items-center gap-3">
            <Logo size={38} />
            <Wordmark className="text-2xl" />
          </div>
          <span className="relative pl-[3.25rem] text-[0.62rem] font-medium tracking-widest text-text-faint uppercase">{panelLabel}</span>
        </div>

        {/* The rail is viewport-height and fixed; with three sections plus a
            footer it can genuinely overflow on a short laptop screen. This is
            one of the few scroll containers the redesign keeps on purpose. */}
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {sections.map((section) => (
            <div key={section.id}>
              <p className="px-3 pb-1.5 text-[0.68rem] font-semibold tracking-wider text-text-faint uppercase">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink key={String(item.to)} item={item} onNavigate={closeSidebar} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Avatar name={user?.username} email={user?.email} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{user?.username ?? '—'}</p>
              <p className="truncate text-xs text-text-muted">{user?.email ?? ''}</p>
            </div>
          </div>
          <div className="mt-1 flex gap-1">
            <Link
              to={settingsTo}
              onClick={closeSidebar}
              className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <SettingsIcon className="h-4 w-4" aria-hidden="true" />
              Configurações
            </Link>
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="Sair"
              title="Sair"
              className="rounded-lg px-3 py-2 text-text-muted transition-colors hover:bg-fail-tint hover:text-fail"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
