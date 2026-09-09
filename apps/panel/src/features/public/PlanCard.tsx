import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Sparkles } from 'lucide-react';
import type { PublicPlan } from '@/shared/api/types';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Badge, Button, Card, CardBody } from '@/ui/primitives';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';
import { discountPercent, formatBillingPeriod, formatMemory, formatPrice, formatRange, formatVcpu } from '@/shared/format/plan';

const AVAILABILITY_LABEL: Record<PublicPlan['availability']['status'], string> = {
  available: 'Disponível',
  limited: 'Poucas vagas',
  sold_out: 'Esgotado',
};
const AVAILABILITY_TONE: Record<PublicPlan['availability']['status'], 'ok' | 'warn' | 'fail'> = {
  available: 'ok',
  limited: 'warn',
  sold_out: 'fail',
};

/**
 * One plan card — the atom of both the public grid (`PublicPlansPage`)
 * and the landing page's plan preview strip. Availability AND the
 * discount percentage are both rendered exactly as the backend computed
 * them (`PublicPlansService.computeAvailability`, `discountPercent` off
 * `compareAtPriceCents`) — this component never re-derives "is there
 * capacity" or invents a price, per the commercial plan's rule that the
 * frontend must never decide either on its own.
 */
export function PlanCard({ plan, highlight = plan.isFeatured }: { plan: PublicPlan; highlight?: boolean }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const soldOut = plan.availability.status === 'sold_out';
  const pctOff = discountPercent(plan.priceCents, plan.compareAtPriceCents);

  const players = formatRange(plan.recommendedPlayersMin, plan.recommendedPlayersMax);

  const ctaLabel = soldOut ? 'Esgotado' : 'Assinar plano';
  const cta = soldOut ? (
    <Button variant="secondary" disabled className="w-full">
      {ctaLabel}
    </Button>
  ) : accessToken ? (
    <Link to="/checkout/$planSlug" params={{ planSlug: plan.slug }}>
      <Button variant="primary" className="w-full">
        {ctaLabel}
      </Button>
    </Link>
  ) : (
    <Link to="/checkout/$planSlug" params={{ planSlug: plan.slug }}>
      <Button variant="primary" className="w-full">
        {ctaLabel}
      </Button>
    </Link>
  );

  return (
    <Card className={`flex flex-col overflow-hidden ${highlight ? 'border-accent shadow-md ring-1 ring-accent/30' : ''}`}>
      {/* Decorative brand-gradient band, same CircuitPattern motif the
          sidebar header uses (sidebar-brand__circuit) — purely visual,
          carries no plan data, so it's identical across every card. */}
      <div className="plan-card-hero relative flex h-24 shrink-0 items-start justify-between p-3">
        <CircuitPattern className="plan-card-hero__circuit" />
        <div className="relative">
          {highlight && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-accent-strong shadow-sm">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {plan.highlightLabel ?? 'Mais popular'}
            </span>
          )}
        </div>
        <div className="relative">
          <Badge tone={AVAILABILITY_TONE[plan.availability.status]}>{AVAILABILITY_LABEL[plan.availability.status]}</Badge>
        </div>
      </div>

      <CardBody className="flex flex-1 flex-col gap-5">
        <div>
          <h3 className="text-base font-semibold text-text">{plan.name}</h3>
          {plan.description && <p className="mt-0.5 text-sm text-text-muted">{plan.description}</p>}
        </div>

        <div>
          {pctOff != null && (
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm text-text-faint line-through">{formatPrice(plan.compareAtPriceCents!, plan.currency)}</span>
              <Badge tone="warn">{pctOff}% OFF</Badge>
            </div>
          )}
          <p>
            <span className="text-3xl font-bold text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
            <span className="text-sm font-medium text-text-faint"> /{formatBillingPeriod(plan.billingPeriod)}</span>
          </p>
        </div>

        <ul className="flex flex-1 flex-col gap-2 text-sm text-text">
          <SpecRow>{formatMemory(plan.memoryMb)} de RAM</SpecRow>
          <SpecRow>{formatVcpu(plan.cpuLimitPercent)}</SpecRow>
          <SpecRow>{formatMemory(plan.diskMb)} de armazenamento</SpecRow>
          {plan.maxBackups > 0 && <SpecRow>Até {plan.maxBackups} backups</SpecRow>}
          {players && <SpecRow>Recomendado para {players} jogadores</SpecRow>}
        </ul>

        <div className="mt-auto">{cta}</div>
      </CardBody>
    </Card>
  );
}

function SpecRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <Check className="h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}
