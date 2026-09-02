import { Link } from '@tanstack/react-router';
import { Rocket } from 'lucide-react';
import type { ClientPlan } from '@/shared/api/types';
import { Card, CardBody } from '@/ui/primitives';
import { formatMemory, formatRange } from './planFormat';

interface UpsellCardProps {
  currentPlan: ClientPlan;
  plans: ClientPlan[];
}

/**
 * Quiet, single-line-of-reasoning upsell — never an Alert (that reads as a
 * problem), never a discount countdown, never auto-dismissing. Picks the
 * next plan up by sortOrder then memoryMb; returns null when there isn't
 * one, so a customer already on the top plan is never advertised at.
 */
export function UpsellCard({ currentPlan, plans }: UpsellCardProps) {
  const next = plans
    .filter((p) => p.id !== currentPlan.id && p.memoryMb > currentPlan.memoryMb)
    .sort((a, b) => a.memoryMb - b.memoryMb)[0];

  if (!next) return null;

  const players = formatRange(next.recommendedPlayersMin, next.recommendedPlayersMax);

  return (
    <Card>
      <CardBody className="flex items-start gap-3">
        <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-text">Seu servidor está crescendo?</p>
          <p className="mt-1 text-text-muted">
            O plano <span className="font-semibold text-text">{next.name}</span> oferece {formatMemory(next.memoryMb)} de RAM
            {players && <> e suporta {players} jogadores</>}.
          </p>
          <Link
            to="/client/plan"
            className="mt-3 inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-[0.8125rem] font-medium text-text shadow-xs transition hover:border-border-strong hover:bg-surface-2"
          >
            Conheça o plano {next.name}
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
