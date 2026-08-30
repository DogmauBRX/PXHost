import { Menu, Moon, Sun } from 'lucide-react';
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
