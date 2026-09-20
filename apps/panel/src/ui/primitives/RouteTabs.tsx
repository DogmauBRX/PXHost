import { Fragment } from 'react';
import { Link, useMatchRoute } from '@tanstack/react-router';
import type { LinkProps } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';

export interface RouteTab {
  to: LinkProps['to'];
  label: string;
  /** Match this path exactly instead of fuzzily — needed for index routes. */
  exact?: boolean;
  /** "Somar e agrupar" (client-features Fase 7): nothing is ever removed, tabs are just visually clustered. Omit on every item to render the old flat, unlabeled bar. */
  group?: 'basico' | 'avancado';
  /** Small visual anchor for fast recognition in server navigation. */
  icon?: LucideIcon;
}

const GROUP_LABEL: Record<NonNullable<RouteTab['group']>, string> = {
  basico: 'Básico',
  avancado: 'Avançado',
};

interface RouteTabsProps {
  items: readonly RouteTab[];
  /** Route params forwarded to every tab (e.g. `{ serverId }`). */
  params?: Record<string, string>;
  className?: string;
}

/**
 * The active-pill nav that `admin.tsx` and `servers.$serverId.tsx` each had
 * their own copy of. Same behaviour, one implementation.
 */
export function RouteTabs({ items, params, className = '' }: RouteTabsProps) {
  const matchRoute = useMatchRoute();

  return (
    <nav aria-label="Navegação do servidor" className={`-mb-px flex items-center gap-1 overflow-x-auto border-b border-border bg-gradient-to-r from-surface via-surface-2/70 to-surface [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {items.map((tab, i) => {
        const active = Boolean(
          matchRoute({ to: tab.to, params, fuzzy: tab.exact ? false : undefined } as never),
        );
        const showGroupLabel = tab.group && tab.group !== items[i - 1]?.group;
        // A vertical rule between groups, not just a margin — found live
        // (screenshot) the plain-text "AVANÇADO" label alone read as more
        // tabs, not a section break. Only between groups, never before the
        // first one.
        const showDivider = showGroupLabel && i > 0;
        return (
          <Fragment key={String(tab.to)}>
            {showDivider && <span className="mx-2 h-6 w-px shrink-0 self-center bg-border" aria-hidden="true" />}
            {showGroupLabel && (
              <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 self-center rounded-full border border-border bg-surface px-2.5 py-1 text-[0.65rem] font-bold tracking-[0.14em] text-text-muted uppercase shadow-xs">
                <span className={`h-1.5 w-1.5 rounded-full ${tab.group === 'basico' ? 'bg-accent' : 'bg-text-faint'}`} aria-hidden="true" />
                {GROUP_LABEL[tab.group!]}
              </span>
            )}
            <Link
              to={tab.to}
              params={params as never}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-all duration-200 ${
                active
                  ? 'bg-accent-tint text-accent-strong shadow-xs ring-1 ring-accent/20 after:absolute after:right-3 after:bottom-0 after:left-3 after:h-0.5 after:rounded-full after:bg-accent'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {tab.icon && <tab.icon className={`h-4 w-4 transition-transform duration-200 group-hover:scale-110 ${active ? 'text-accent-strong' : 'text-text-faint group-hover:text-text-muted'}`} aria-hidden="true" />}
              {tab.label}
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
