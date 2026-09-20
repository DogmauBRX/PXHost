import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  LogIn,
  Menu,
  RefreshCcw,
  Scale,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Button } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';
import { AnnouncementBanner } from '@/ui/layout/AnnouncementBanner';

const footerTopics = [
  { label: 'Pagamentos e segurança', icon: CreditCard, to: '/central', hash: 'pagamentos' },
  { label: 'Confiança e transparência', icon: BadgeCheck, to: '/central', hash: 'transparencia' },
  { label: 'Resposta a ataques', icon: ShieldAlert, to: '/central', hash: 'seguranca' },
  { label: 'Política de reembolso', icon: RefreshCcw, to: '/central', hash: 'reembolsos' },
  { label: 'Suporte', icon: LifeBuoy, to: '/central', hash: 'suporte' },
  { label: 'Comunidade e redes', icon: Share2 },
  { label: 'Termos de uso', icon: Scale, to: '/termos' },
] as const;

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
  const accessToken = useAuthStore((s) => s.accessToken);
  const username = useAuthStore((s) => s.user?.username);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const [mobileOpen, setMobileOpen] = useState(false);

  const dashboardTo = isAdmin ? '/admin' : '/client';
  // Swaps to "Início" → "/" whenever the visitor is already somewhere under
  // /plans (the catalog itself or a plan detail page) — pointing a "Ver
  // planos" button at the page already on screen isn't a useful link.
  const pathname = useLocation({ select: (l) => l.pathname });
  const onPlans = pathname.startsWith('/plans');
  const onCentral = pathname.startsWith('/central');
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
            <span className="hidden h-8 w-px bg-white/10 lg:block" aria-hidden="true" />
            <nav className="hidden items-center gap-2 lg:flex" aria-label="Navegação pública principal">
              <Link
                to={catalogNavTo}
                search={onPlans ? homeSearch : undefined}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-white/70 transition-all hover:border-accent/35 hover:bg-white/10 hover:text-white"
              >
                <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                {catalogNavLabel}
              </Link>
              <Link
                to="/central"
                aria-current={onCentral ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition-all ${
                  onCentral
                    ? 'border-accent/30 bg-accent/10 text-accent'
                    : 'border-white/10 bg-white/5 text-white/70 hover:border-accent/35 hover:bg-white/10 hover:text-white'
                }`}
              >
                <BookOpenCheck className="h-4 w-4 text-accent" aria-hidden="true" />
                Como funciona
              </Link>
            </nav>
          </div>

          <div className="hidden items-center gap-3 lg:flex">
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
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/70 hover:bg-white/10 hover:text-white lg:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="relative border-t border-white/10 bg-[#17191e]/95 px-4 py-4 backdrop-blur-xl lg:hidden">
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
              <Link
                to="/central"
                onClick={() => setMobileOpen(false)}
                aria-current={onCentral ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ${
                  onCentral ? 'bg-accent/10 text-accent' : 'text-white/75 hover:bg-white/5 hover:text-white'
                }`}
              >
                <BookOpenCheck className="h-4 w-4 text-accent" aria-hidden="true" />
                Como funciona
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
            </nav>
          </div>
        )}
      </header>

      <AnnouncementBanner />

      <main>{children}</main>

      <footer className="public-footer">
        <CircuitPattern className="public-footer__circuit" />

        <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
          <div className="public-footer__cta mb-12 flex flex-col gap-6 rounded-2xl border border-white/10 px-5 py-6 sm:px-7 lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <div className="flex items-start gap-4">
              <span className="public-footer__signal mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[0.65rem] font-bold tracking-[0.2em] text-accent uppercase">Infraestrutura GX</p>
                <h2 className="mt-1 text-xl font-semibold tracking-tight text-white sm:text-2xl">Seu próximo servidor começa aqui.</h2>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-white/50">Deploy rápido, controle completo e uma plataforma feita para acompanhar sua comunidade.</p>
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <Link
                to="/plans"
                className="flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-5 text-sm font-semibold text-white/75 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
              >
                Explorar planos
              </Link>
              <Link
                to={accessToken ? dashboardTo : '/register'}
                className="group flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-accent-contrast shadow-[0_12px_30px_-16px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong"
              >
                {accessToken ? 'Abrir painel' : 'Criar minha conta'}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="grid gap-10 border-b border-white/8 pb-10 md:grid-cols-[1.1fr_0.6fr_1.4fr] lg:gap-16">
            <div>
              <Link to="/" search={homeSearch} className="group inline-flex items-center gap-3" aria-label="GXhost — página inicial">
                <span className="public-footer__logo flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                  <Logo size={38} />
                </span>
                <span className="flex flex-col">
                  <Wordmark className="text-2xl leading-none" />
                  <span className="mt-1 text-[0.55rem] font-bold tracking-[0.22em] text-white/35 uppercase">Cloud gaming infrastructure</span>
                </span>
              </Link>
              <p className="mt-5 max-w-sm text-sm leading-6 text-white/45">Hospedagem de servidores Minecraft com desempenho, automação e controle em uma experiência simples.</p>
              <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/5 px-3 py-1.5 text-[0.65rem] font-semibold tracking-wide text-emerald-300/80 uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.8)]" aria-hidden="true" />
                Plataforma operacional
              </span>
            </div>

            <nav aria-label="Navegação do rodapé">
              <p className="mb-4 text-[0.65rem] font-bold tracking-[0.2em] text-white/35 uppercase">Navegar</p>
              <div className="flex flex-col items-start gap-3 text-sm">
                <Link to="/" search={homeSearch} className="text-white/55 transition-colors hover:text-accent">Início</Link>
                <Link to="/plans" className="text-white/55 transition-colors hover:text-accent">Planos</Link>
                <Link to={accessToken ? dashboardTo : '/login'} className="text-white/55 transition-colors hover:text-accent">
                  {accessToken ? 'Meu painel' : 'Entrar'}
                </Link>
                {!accessToken && <Link to="/register" className="text-white/55 transition-colors hover:text-accent">Criar conta</Link>}
              </div>
            </nav>

            <div>
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-[0.65rem] font-bold tracking-[0.2em] text-white/35 uppercase">Central GX</p>
                <Link to="/central" className="group flex items-center gap-1 text-[0.58rem] font-bold tracking-wider text-accent/75 uppercase transition-colors hover:text-accent">
                  Conhecer a central
                  <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {footerTopics.map((topic) => 'to' in topic ? (
                  <Link key={topic.label} to={topic.to} hash={'hash' in topic ? topic.hash : undefined} className="public-footer__topic group flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
                    <topic.icon className="h-3.5 w-3.5 shrink-0 text-accent/65 transition-colors group-hover:text-accent" aria-hidden="true" />
                    <span className="text-xs font-medium text-white/45 transition-colors group-hover:text-white/75">{topic.label}</span>
                  </Link>
                ) : (
                  <div key={topic.label} className="public-footer__topic flex items-center justify-between gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5" title="Conteúdo em desenvolvimento">
                    <span className="flex items-center gap-2.5"><topic.icon className="h-3.5 w-3.5 shrink-0 text-accent/45" aria-hidden="true" /><span className="text-xs font-medium text-white/35">{topic.label}</span></span>
                    <span className="text-[0.48rem] font-bold tracking-wider text-white/20 uppercase">Em breve</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 pt-7 text-[0.68rem] leading-5 text-white/30 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p>© {new Date().getFullYear()} GXhost. Todos os direitos reservados.</p>
              <p>Hospedagem inteligente para comunidades que querem crescer.</p>
            </div>
            <p className="max-w-xl sm:text-right">"Minecraft" é uma marca registrada de Mojang Synergies AB. A GXhost não é afiliada, endossada ou patrocinada pela Mojang ou pela Microsoft.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
