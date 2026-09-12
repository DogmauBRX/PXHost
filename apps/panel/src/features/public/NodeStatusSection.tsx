import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, TriangleAlert, Wrench, CircleX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getPublicNodeStatus } from './public.api';
import { Badge } from '@/ui/primitives';
import type { PlatformStatusLevel } from '@/shared/api/types';

const STATUS_META: Record<PlatformStatusLevel, { label: string; tone: 'ok' | 'warn' | 'neutral' | 'fail'; icon: LucideIcon }> = {
  operational: { label: 'Operacional', tone: 'ok', icon: CircleCheck },
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
 * real `@Public()` API call, aggregated ACROSS EVERY public node
 * (`PublicStatusService`) into ONE overall signal — no individual node
 * or location name ever reaches a visitor's browser.
 *
 * A single card, not a grid: an earlier version broke this down per
 * location, which with today's node counts just meant one card
 * restating the same thing "por região" implied wasn't the point. The
 * platform owner's own call (2026-09-12): one badge, and it reads
 * "Operacional" the moment at least one public node is online —
 * whatever else is happening elsewhere is an ops concern, not something
 * a visitor deciding whether to sign up needs to parse.
 *
 * The section itself is always visible to a logged-out visitor — that
 * was the whole point of asking for it on the main page: someone with
 * no account has to be able to tell the platform is alive without
 * logging in anywhere. What changes is only the body:
 *  - no public node registered yet → a plain "Offline" badge. Nothing
 *    is actually online right now (no node deployed = nothing to serve
 *    traffic), so that's the honest state — not a fabricated
 *    "operational". The moment a real public node comes up in
 *    production, `status` flips to non-null on its own (next 30s poll)
 *    and this branch is replaced by the real card below, no code
 *    change needed to "turn it online".
 *  - the request itself failed (API unreachable) → a neutral "couldn't
 *    load status right now" note, never a silent blank section.
 *  - real status → the card below, unchanged.
 */
export function NodeStatusSection() {
  const {
    data: status,
    isPending,
    isError,
  } = useQuery({ queryKey: ['public', 'node-status'], queryFn: getPublicNodeStatus, refetchInterval: 30_000 });

  if (isPending) return null;

  const hasStatus = !isError && !!status;

  return (
    <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <h2 className="text-2xl font-bold text-text sm:text-3xl">Status da infraestrutura</h2>
        <p className="mt-3 text-text-muted">Disponibilidade em tempo real da nossa infraestrutura.</p>
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

      {!isError && !hasStatus && (
        <div className="mx-auto max-w-md rounded-card border border-border bg-surface p-5 text-center">
          <Badge tone="fail">
            <span className="inline-flex items-center gap-1">
              <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
              Offline
            </span>
          </Badge>
        </div>
      )}

      {hasStatus &&
        (() => {
          const meta = STATUS_META[status.status];
          const Icon = meta.icon;
          return (
            <div className="mx-auto max-w-md rounded-card border border-border bg-surface p-5 text-center">
              <Badge tone={meta.tone}>
                <span className="inline-flex items-center gap-1">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {meta.label}
                </span>
              </Badge>
              {/* Only ever populated when status !== 'maintenance' — see
                  PublicStatusService's own doc comment — so this note
                  and the badge above never contradict each other. */}
              {status.nextMaintenanceAt && (
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-text-muted">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Entra em manutenção em {scheduleFormatter.format(new Date(status.nextMaintenanceAt))}
                </p>
              )}
            </div>
          );
        })()}
    </section>
  );
}
