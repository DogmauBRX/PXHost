import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { Button } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';

/**
 * The layout for every public, unauthenticated-facing page (`/`,
 * `/plans`, `/plans/:slug`, `/register`) — a separate visual system from
 * `AppShell` (login.tsx's own doc comment already establishes this
 * split for the login screen), because this is a marketing/commercial
 * surface, not a working dashboard (commercial plan §21: "não
 * transformar o site em um dashboard").
 *
 * A logged-in visitor CAN reach these pages (a customer browsing
 * `/plans` to consider upgrading, e.g.) — the header adapts to "Ir para
 * o painel" instead of Entrar/Criar conta rather than pretending they're
 * logged out, but never redirects them away the way `/` itself does for
 * an authenticated user (see app/routes/index.tsx).
 */
export function PublicShell({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const [mobileOpen, setMobileOpen] = useState(false);

  const dashboardTo = isAdmin ? '/admin' : '/client';

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <Logo size={30} />
            <Wordmark className="text-xl" />
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
            <Link to="/plans" className="text-sm font-medium text-text-muted transition-colors hover:text-text" activeProps={{ className: 'text-text' }}>
              Planos
            </Link>
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
              title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>
            {accessToken ? (
              <Link to={dashboardTo}>
                <Button variant="primary">Ir para o painel</Button>
              </Link>
            ) : (
              <>
                <Link to="/login">
                  <Button variant="ghost">Entrar</Button>
                </Link>
                <Link to="/register">
                  <Button variant="primary">Criar conta</Button>
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
            className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="border-t border-border bg-surface px-4 py-4 md:hidden">
            <nav className="flex flex-col gap-1">
              <Link to="/plans" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-2">
                Planos
              </Link>
              {accessToken ? (
                <Link to={dashboardTo} onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-2">
                  Ir para o painel
                </Link>
              ) : (
                <>
                  <Link to="/login" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-2">
                    Entrar
                  </Link>
                  <Link to="/register" onClick={() => setMobileOpen(false)} className="mt-1">
                    <Button variant="primary" className="w-full">
                      Criar conta
                    </Button>
                  </Link>
                </>
              )}
              <button
                type="button"
                onClick={toggleTheme}
                className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-text-muted hover:bg-surface-2 hover:text-text"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
              </button>
            </nav>
          </div>
        )}
      </header>

      <main>{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-10 text-center sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Logo size={22} />
            <Wordmark className="text-base" />
          </div>
          <p className="text-xs text-text-faint">© {new Date().getFullYear()} PXHost. Todos os direitos reservados.</p>
        </div>
      </footer>
    </div>
  );
}
