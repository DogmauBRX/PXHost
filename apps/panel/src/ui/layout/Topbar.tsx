import { Home, Menu } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useUiStore } from '@/shared/stores/ui.store';

export function Topbar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label="Abrir menu"
        className="-ml-1 rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Spacer so the home link stays right-aligned once the hamburger
          disappears at lg. */}
      <div className="flex-1" />

      {/* 'stay: true' opts out of '/''s own beforeLoad, which otherwise
          bounces an authenticated visitor straight back to their dashboard
          — without it this would just redirect back to the panel it's
          supposed to leave (same reasoning Sidebar's old home link and
          PublicShell's own homeSearch already document). Moved here from
          Sidebar's brand box (icon-only, awkwardly overlapping the logo)
          to a real labeled button. */}
      <Link
        to="/"
        search={{ stay: true }}
        className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Home className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="hidden sm:inline">Página principal</span>
      </Link>
    </header>
  );
}
