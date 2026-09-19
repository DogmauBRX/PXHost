import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { Button } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { AnnouncementBanner } from '@/ui/layout/AnnouncementBanner';

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
  const username = useAuthStore((s) => s.user?.username);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const [mobileOpen, setMobileOpen] = useState(false);

  const dashboardTo = isAdmin ? '/admin' : '/client';
  // Swaps to "Início" → "/" whenever the visitor is already somewhere under
  // /plans (the catalog itself or a plan detail page) — pointing a "Ver
  // planos" button at the page already on screen isn't a useful link.
  const onPlans = useLocation({ select: (l) => l.pathname }).startsWith('/plans');
  const catalogNavTo = onPlans ? '/' : '/plans';
  const catalogNavLabel = onPlans ? 'Início' : 'Ver planos';
  // `/`'s own beforeLoad bounces a signed-in visitor straight to their
  // dashboard by default (login.tsx's post-login fallback and a plain
  // bookmark both rely on that) — `stay` is this route's own opt-out, so
  // a logged-in customer clicking Início/the logo actually SEES the
  // landing page instead of getting bounced right back to /client every
  // time (see app/routes/index.tsx's own doc comment). Harmless when
  // logged out or when `to` is `/plans` (that route ignores unknown
  // search params, and the guard this opts out of only ever fires for an
  // authenticated visitor anyway).
  const homeSearch = { stay: true } as const;

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <Link to="/" search={homeSearch} className="flex items-center gap-3">
              <Logo size={40} />
              <Wordmark className="text-2xl" />
            </Link>
            <Link to={catalogNavTo} search={onPlans ? homeSearch : undefined} className="hidden md:block">
              <Button variant="secondary">{catalogNavLabel}</Button>
            </Link>
          </div>

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
              <>
                <span className="max-w-[12rem] truncate text-sm text-text-muted">{username}</span>
                <Link to={dashboardTo}>
                  <Button variant="primary">Ir para o painel</Button>
                </Link>
              </>
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
              <Link
                to={catalogNavTo}
                search={onPlans ? homeSearch : undefined}
                onClick={() => setMobileOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-2"
              >
                {catalogNavLabel}
              </Link>
              {accessToken ? (
                <Link
                  to={dashboardTo}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-2"
                >
                  {username && <span className="block text-xs font-normal text-text-muted">{username}</span>}
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

      <AnnouncementBanner />

      <main>{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 lg:px-8">
          <div className="text-center sm:text-left">
            <p className="text-xs font-medium text-text-muted">Douglas Carvalho da Silveira</p>
            <p className="text-xs text-text-faint">CNPJ 68.987.329/0001-21</p>
            <p className="text-xs text-text-faint">Microempreendedor Individual (MEI)</p>
          </div>

          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2">
              <Logo size={22} />
              <Wordmark className="text-base" />
            </div>
            <p className="text-xs text-text-faint">© {new Date().getFullYear()} GXhost. Todos os direitos reservados.</p>
            <p className="max-w-md text-xs text-text-faint">"Minecraft" é uma marca registrada de Mojang Synergies AB.</p>
            <p className="max-w-md text-xs text-text-faint">A GXhost não é afiliada, endossada ou patrocinada pela Mojang ou pela Microsoft.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
