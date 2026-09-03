import { Fragment } from 'react';
import { Link, useMatchRoute } from '@tanstack/react-router';
import type { LinkProps } from '@tanstack/react-router';

export interface RouteTab {
  to: LinkProps['to'];
  label: string;
  /** Match this path exactly instead of fuzzily — needed for index routes. */
  exact?: boolean;
  /** "Somar e agrupar" (client-features Fase 7): nothing is ever removed, tabs are just visually clustered. Omit on every item to render the old flat, unlabeled bar. */
  group?: 'basico' | 'avancado';
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
    <div className={`-mb-px flex items-center gap-1 overflow-x-auto border-b border-border ${className}`}>
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
            {showDivider && <span className="mx-2 h-5 w-px shrink-0 self-center bg-border" aria-hidden="true" />}
            {showGroupLabel && (
              // Same pill language as Badge/StatusBadge's neutral tone
              // (rounded, muted fill) so it reads as "this is a label,"
              // not one more clickable tab — but sized up from Badge's
              // own tiny 0.68rem (not just reusing that component
              // directly) since this sits inline with 0.875rem tab text
              // and needs to hold its own next to it, not disappear.
              <span className="mr-1 shrink-0 self-center rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
                {GROUP_LABEL[tab.group!]}
              </span>
            )}
            <Link
              to={tab.to}
              params={params as never}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-accent text-accent-strong'
                  : 'border-transparent text-text-muted hover:border-border-strong hover:text-text'
              }`}
            >
              {tab.label}
            </Link>
          </Fragment>
        );
      })}
    </div>
  );
}
