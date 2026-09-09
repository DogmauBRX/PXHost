import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, TriangleAlert, Wrench, CircleX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getPublicNodeStatus } from './public.api';
import { Badge } from '@/ui/primitives';
import type { LocationStatusLevel } from '@/shared/api/types';

const STATUS_META: Record<LocationStatusLevel, { label: string; tone: 'ok' | 'warn' | 'neutral' | 'fail'; icon: LucideIcon }> = {
  operational: { label: 'Operacional', tone: 'ok', icon: CircleCheck },
  degraded: { label: 'Instável', tone: 'warn', icon: TriangleAlert },
  maintenance: { label: 'Em manutenção', tone: 'neutral', icon: Wrench },
  offline: { label: 'Offline', tone: 'fail', icon: CircleX },
};

const scheduleFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Real infrastructure status — deliberately separate from
 * `BrazilLatencyMap`/`NetworkAnimation` just above on this same page,
 * both of which are explicitly documented as decorative-only (see their
 * own doc comments: "no real per-region latency telemetry backs these
 * dots"). This section is the opposite: `getPublicNodeStatus()` is a
 * real `@Public()` API call, aggregated per LOCATION server-side
 * (`PublicStatusService`) so no individual node name/fqdn ever reaches
 * a visitor's browser.
 *
 * The section itself is always visible to a logged-out visitor — that
 * was the whole point of asking for it on the main page: someone with
 * no account has to be able to tell the platform is alive without
 * logging in anywhere. What changes is only the body:
 *  - no public node registered yet → a plain "Offline" badge, same
 *    tone/icon as a real offline location below. Nothing is actually
 *    online right now (no node deployed = nothing to serve traffic),
 *    so that's the honest state — not a fabricated "operational". The
 *    moment a real public node comes up in production, `hasLocations`
 *    flips to true on its own (next 30s poll) and this branch is
 *    replaced by the real per-location cards below, no code change
 *    needed to "turn it online".
 *  - the request itself failed (API unreachable) → a neutral "couldn't
 *    load status right now" note, never a silent blank section.
 *  - real location data → the per-location cards below, unchanged.
 */
export function NodeStatusSection() {
  const {
    data: locations,
    isPending,
    isError,
  } = useQuery({ queryKey: ['public', 'node-status'], queryFn: getPublicNodeStatus, refetchInterval: 30_000 });

  if (isPending) return null;

  const hasLocations = !isError && !!locations && locations.length > 0;

  return (
    <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <h2 className="text-2xl font-bold text-text sm:text-3xl">Status da infraestrutura</h2>
        <p className="mt-3 text-text-muted">Disponibilidade em tempo real dos nossos nodes, por região.</p>
      </div>

      {isError && (
        <div className="mx-auto max-w-md rounded-card border border-border bg-surface p-5 text-center">
          <Badge tone="warn">
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Status indisponível
            </span>
          </Badge>
          <p className="mt-3 text-sm text-text-muted">
            Não conseguimos carregar o status agora. Isso não quer dizer que a plataforma esteja fora do ar — tente atualizar a página em instantes.
          </p>
        </div>
      )}

      {!isError && !hasLocations && (
        <div className="mx-auto max-w-md rounded-card border border-border bg-surface p-5 text-center">
          <Badge tone="fail">
            <span className="inline-flex items-center gap-1">
              <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
              Offline
            </span>
          </Badge>
        </div>
      )}

      {hasLocations && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {locations!.map((location) => {
            const meta = STATUS_META[location.status];
            const Icon = meta.icon;
            return (
              <div key={location.id} className="rounded-card border border-border bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-text">{location.name}</p>
                    <p className="text-xs text-text-faint">{location.shortCode}</p>
                  </div>
                  <Badge tone={meta.tone}>
                    <span className="inline-flex items-center gap-1">
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {meta.label}
                    </span>
                  </Badge>
                </div>
                {/* Only ever populated when status !== 'maintenance' — see
                    PublicStatusService's own doc comment — so this note
                    and the badge above never contradict each other. */}
                {location.nextMaintenanceAt && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Entra em manutenção em {scheduleFormatter.format(new Date(location.nextMaintenanceAt))}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
