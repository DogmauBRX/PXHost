import { Home, Menu, Moon, Sun } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useUiStore } from '@/shared/stores/ui.store';
import { useThemeStore } from '@/shared/theme/theme.store';

export function Topbar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

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

      {/* Spacer so the theme button stays right-aligned once the hamburger
          disappears at lg. */}
      <div className="flex-1" />

      {/* 'stay: true' opts out of '/''s own beforeLoad, which otherwise
          bounces an authenticated visitor straight back to their dashboard
          — without it this would just redirect back to the panel it's
          supposed to leave (same reasoning Sidebar's old home link and
          PublicShell's own homeSearch already document). Moved here from
          Sidebar's brand box (icon-only, awkwardly overlapping the logo)
          to a real labeled button next to the theme toggle. */}
      <Link
        to="/"
        search={{ stay: true }}
        className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Home className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="hidden sm:inline">Página principal</span>
      </Link>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
      </button>
    </header>
  );
}
