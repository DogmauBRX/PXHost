import { ChevronRight, Home, LayoutDashboard, Menu } from 'lucide-react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useUiStore } from '@/shared/stores/ui.store';

function currentSection(pathname: string, area: 'admin' | 'client') {
  if (pathname.includes('/servers/')) return 'Servidor';
  if (pathname.includes('/servers')) return area === 'admin' ? 'Servidores' : 'Meus servidores';
  if (pathname.includes('/nodes')) return 'Nodes';
  if (pathname.includes('/plans') || pathname.includes('/plan')) return 'Plano';
  if (pathname.includes('/subscription')) return 'Assinatura';
  if (pathname.includes('/settings')) return 'Configurações';
  if (pathname.includes('/support')) return 'Suporte';
  if (pathname.includes('/assistant')) return 'Assistente';
  if (pathname.includes('/users')) return 'Usuários';
  return 'Visão geral';
}

export function Topbar({ area }: { area: 'admin' | 'client' }) {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const panelLabel = area === 'admin' ? 'Painel Admin' : 'Painel Cliente';
  const sectionLabel = currentSection(pathname, area);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-border/80 bg-surface/90 px-4 shadow-[0_8px_24px_-24px_rgb(0_0_0/0.9)] backdrop-blur-xl sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Abrir menu"
          className="-ml-1 rounded-xl border border-transparent p-2 text-text-muted transition-colors hover:border-border hover:bg-surface-2 hover:text-text lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="hidden min-w-0 items-center gap-3 sm:flex">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent-strong shadow-[0_8px_18px_-14px_var(--color-accent)]">
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[0.63rem] font-bold tracking-[0.14em] text-text-faint uppercase">GXhost · {panelLabel}</p>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm font-semibold text-text">
              <span className="truncate">{sectionLabel}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden="true" />
              <span className="hidden text-xs font-medium text-text-muted md:inline">Painel de controle</span>
            </div>
          </div>
        </div>
      </div>

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
        className="group relative flex items-center gap-2 rounded-xl border border-border bg-surface-2/55 px-3 py-2 text-sm font-medium text-text-muted shadow-xs transition-all hover:-translate-y-px hover:border-accent/35 hover:bg-accent/10 hover:text-accent-strong"
      >
        <Home className="h-4 w-4 transition-transform group-hover:-translate-y-px" aria-hidden="true" />
        <span className="hidden sm:inline">Página principal</span>
      </Link>
    </header>
  );
}
