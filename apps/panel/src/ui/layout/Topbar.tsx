import { Gamepad2, Home, Menu } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useUiStore } from '@/shared/stores/ui.store';
import { FriendsDrawer } from './FriendsDrawer';

export function Topbar({ area }: { area: 'admin' | 'client' }) {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-border/80 bg-surface/90 px-4 shadow-[0_8px_24px_-24px_rgb(0_0_0/0.9)] backdrop-blur-xl sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent" aria-hidden="true" />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Abrir menu"
          className="-ml-1 rounded-xl border border-transparent p-2 text-text-muted transition-colors hover:border-border hover:bg-surface-2 hover:text-text lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* 'stay: true' opts out of '/''s own beforeLoad, which otherwise
            bounces an authenticated visitor straight back to their dashboard
            — without it this would just redirect back to the panel it's
            supposed to leave (same reasoning Sidebar's old home link and
            PublicShell's own homeSearch already document). Moved here from
            Sidebar's brand box (icon-only, awkwardly overlapping the logo)
            to a real labeled button. */}
        <div className="flex items-center gap-2">
          <Link
            to="/"
            search={{ stay: true }}
            className="group relative flex items-center gap-2 rounded-xl border border-border bg-surface-2/55 px-3 py-2 text-sm font-medium text-text-muted shadow-xs transition-all hover:-translate-y-px hover:border-accent/35 hover:bg-accent/10 hover:text-accent-strong"
          >
            <Home className="h-4 w-4 transition-transform group-hover:-translate-y-px" aria-hidden="true" />
            <span className="hidden sm:inline">Página principal</span>
          </Link>
        </div>
      </div>
      {area === 'client' && (
        <div className="flex items-center gap-2">
          <Link
            to="/client/community"
            className="group relative flex items-center gap-2 rounded-xl border border-emerald-300/45 bg-surface-2 px-3 py-2 text-sm font-medium text-emerald-300 shadow-xs transition-all hover:-translate-y-px hover:border-emerald-200 hover:bg-surface-3 hover:text-emerald-200"
          >
            <Gamepad2 className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Comunidade</span>
          </Link>
          <FriendsDrawer />
        </div>
      )}
    </header>
  );
}
