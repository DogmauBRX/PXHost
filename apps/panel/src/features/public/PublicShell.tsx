import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowRight, LayoutDashboard, LogIn, Menu, Moon, Sparkles, Sun, UserPlus, X } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { Button } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';
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
 * `/plans` to consider upgrading, e.g.) — the header adapts to "Abrir
 * painel" instead of Entrar/Criar conta rather than pretending they're
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
      <header className="public-header--graphite sticky top-0 z-30 overflow-hidden border-b border-white/10 shadow-[0_12px_35px_-26px_rgba(0,0,0,0.9)]">
        <CircuitPattern className="public-header__circuit" />
        <div className="relative mx-auto flex h-[4.75rem] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <Link to="/" search={homeSearch} className="group flex items-center gap-3" aria-label="GXhost — página inicial">
              <span className="public-header__logo-shell flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 shadow-lg backdrop-blur-sm transition-transform duration-300 group-hover:-translate-y-0.5">
                <Logo size={36} />
              </span>
              <span className="flex flex-col">
                <Wordmark className="text-2xl leading-none" />
                <span className="mt-1 hidden text-[0.57rem] font-bold tracking-[0.2em] text-white/40 uppercase sm:block">Cloud gaming infrastructure</span>
              </span>
            </Link>
            <span className="hidden h-8 w-px bg-white/10 md:block" aria-hidden="true" />
            <Link
              to={catalogNavTo}
              search={onPlans ? homeSearch : undefined}
              className="hidden items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-white/70 transition-all hover:border-accent/35 hover:bg-white/10 hover:text-white md:flex"
            >
              <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
              {catalogNavLabel}
            </Link>
          </div>

          <div className="hidden items-center gap-3 md:flex">
            {accessToken ? (
              <>
                <span className="flex max-w-[15rem] items-center gap-2 rounded-full border border-white/10 bg-black/15 px-3 py-1.5 text-xs text-white/50">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_8px_var(--color-ok)]" aria-hidden="true" />
                  <span className="truncate">Sessão de <strong className="font-semibold text-white/85">{username}</strong></span>
                </span>
                <Link to={dashboardTo} className="group flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-contrast shadow-[0_8px_24px_-12px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong">
                  <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                  Abrir painel
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </>
            ) : (
              <>
                <Link to="/login" className="flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white/75 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white">
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  Entrar
                </Link>
                <Link to="/register" className="group flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-contrast shadow-[0_8px_24px_-12px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong">
                  <UserPlus className="h-4 w-4" aria-hidden="true" />
                  Criar conta
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </>
            )}
            {/* Separated from the CTA cluster with its own divider — a
                utility control tucked in the header's own top-right corner,
                not another button competing with Entrar/Criar conta. */}
            <span className="h-6 w-px bg-white/10" aria-hidden="true" />
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
              title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
              className="rounded-xl border border-transparent p-2 text-white/55 transition-colors hover:border-white/10 hover:bg-white/5 hover:text-white"
            >
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/70 hover:bg-white/10 hover:text-white md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="relative border-t border-white/10 bg-[#17191e]/95 px-4 py-4 backdrop-blur-xl md:hidden">
            <nav className="flex flex-col gap-1">
              <Link
                to={catalogNavTo}
                search={onPlans ? homeSearch : undefined}
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-white/75 hover:bg-white/5 hover:text-white"
              >
                <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                {catalogNavLabel}
              </Link>
              {accessToken ? (
                <Link
                  to={dashboardTo}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-xl px-3 py-2.5 text-sm font-medium text-white/80 hover:bg-white/5 hover:text-white"
                >
                  {username && (
                    <span className="block text-xs font-normal text-white/45">
                      Sessão de <span className="font-medium text-white/80">{username}</span>
                    </span>
                  )}
                  Abrir painel
                </Link>
              ) : (
                <>
                  <Link to="/login" onClick={() => setMobileOpen(false)} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-white/80 hover:bg-white/5 hover:text-white">
                    <LogIn className="h-4 w-4" aria-hidden="true" />
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
                className="mt-1 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-white/55 hover:bg-white/5 hover:text-white"
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
