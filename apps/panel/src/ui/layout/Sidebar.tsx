import { useEffect } from 'react';
import { Link, useMatchRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import type { LinkProps } from '@tanstack/react-router';
import { LogOut, Settings as SettingsIcon, ShieldCheck, User } from 'lucide-react';
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
      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
        active
          ? 'bg-accent-tint text-accent-strong shadow-xs ring-1 ring-accent/15'
          : 'text-text-muted hover:translate-x-0.5 hover:bg-surface-2 hover:text-text'
      }`}
    >
      {active && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-r-full bg-accent" />}
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${active ? 'bg-accent text-accent-contrast shadow-xs' : 'bg-surface-2 text-text-faint group-hover:bg-surface group-hover:text-text-muted'}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

interface SidebarProps {
  sections: readonly NavSection[];
  panelLabel: string;
  settingsTo: LinkProps['to'];
  area: 'admin' | 'client';
}

export function Sidebar({ sections, panelLabel, settingsTo, area }: SidebarProps) {
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
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-surface shadow-[12px_0_36px_-28px_rgba(15,23,42,0.38)] transition-transform duration-200 motion-reduce:transition-none lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="sidebar-brand flex h-28 shrink-0 flex-col justify-center gap-1 border-b border-border px-5">
          <CircuitPattern className="sidebar-brand__circuit" />
          {/* The "voltar para o site" link used to live here as a bare icon
              overlapping this corner — moved to Topbar as a real labeled
              button next to the theme toggle instead. */}
          <div className="relative flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-surface/80 shadow-sm backdrop-blur-sm">
              <Logo size={38} />
            </span>
            <div className="flex flex-col">
              <Wordmark className="text-[1.7rem] leading-none" />
              <span className="mt-1 text-[0.62rem] font-semibold tracking-[0.18em] text-text-faint uppercase">Hospedagem inteligente</span>
            </div>
          </div>
          <span className="relative mt-1 inline-flex w-fit rounded-full border border-border bg-surface/80 px-2.5 py-1 text-[0.6rem] font-bold tracking-[0.15em] text-text-muted uppercase shadow-xs">{panelLabel}</span>
        </div>

        {/* An admin browsing /client/* (the drill-down "view a customer's
            server as they'd see it" flow — admin.servers.$serverId.tsx
            reuses these exact same client pages/routes) has otherwise no
            way to cross between the two short of editing the URL bar: this
            shell renders whichever nav tree `area` says to, with no
            cross-link between the two by design (AppShell's own doc
            comment — "two genuinely separate trees"). This is the one
            deliberate exception, in both directions:
             - client -> admin is gated on the caller's REAL role
               (`user.isAdmin`, always re-derived server-side on login —
               see AuthenticatedUser's own doc comment), never on which
               area happens to be rendering — a non-admin never sees it.
             - admin -> client needs no such gate: reaching `area === 'admin'`
               at all already means `requireAdmin`'s beforeLoad let this
               request through, so any admin here may always look at the
               client view too. */}
        {area === 'client' && user?.isAdmin && (
          <Link
            to="/admin"
            className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-accent/15 bg-accent-tint px-3 py-2.5 text-xs font-semibold text-accent-strong transition-colors hover:bg-accent-tint/70"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Voltar ao Painel Admin
          </Link>
        )}
        {area === 'admin' && (
          <Link
            to="/client"
            className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-accent/15 bg-accent-tint px-3 py-2.5 text-xs font-semibold text-accent-strong transition-colors hover:bg-accent-tint/70"
          >
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            Entrar no Painel Cliente
          </Link>
        )}

        {/* The rail is viewport-height and fixed; with three sections plus a
            footer it can genuinely overflow on a short laptop screen. This is
            one of the few scroll containers the redesign keeps on purpose. */}
        <nav className="flex-1 space-y-7 overflow-y-auto px-3 py-5">
          {sections.map((section) => (
            <div key={section.id}>
              <div className="mb-2 flex items-center gap-2 px-3">
                <p className="text-[0.65rem] font-bold tracking-[0.14em] text-text-faint uppercase">{section.label}</p>
                <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <NavLink key={String(item.to)} item={item} onNavigate={closeSidebar} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-border bg-gradient-to-b from-surface-2/50 to-surface p-3">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface/90 p-3 shadow-xs">
            <span className="rounded-xl ring-2 ring-accent/10"><Avatar name={user?.username} email={user?.email} size="md" /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{user?.username ?? '—'}</p>
              <p className="truncate text-xs text-text-muted">{user?.email ?? ''}</p>
            </div>
          </div>
          <div className={`mt-2 flex gap-1 ${area === 'client' ? 'justify-end' : ''}`}>
            {area === 'admin' && (
              <Link
                to={settingsTo}
                onClick={closeSidebar}
                className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                Configurações
              </Link>
            )}
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="Sair"
              title="Sair"
              className="rounded-xl px-3 py-2 text-text-muted transition-colors hover:bg-fail-tint hover:text-fail"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
