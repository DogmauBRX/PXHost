import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Cpu, Rocket, Server, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

// A quick visual "which tier is this" cue on the hero band, ranked purely
// by RAM — there's no separate tier field on Plan, and every plan here
// already competes on resources, so it's the one number that reliably
// orders "entry" -> "mid" -> "top" regardless of what an admin names or
// prices a plan. Thresholds picked against this deployment's real plans
// (4/6/12 GB) with headroom on both sides, not tied to any specific slug.
function tierIcon(memoryMb: number): LucideIcon {
  if (memoryMb < 5120) return Cpu;
  if (memoryMb < 10240) return Server;
  return Rocket;
}

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
          sidebar header uses (sidebar-brand__circuit). The tier glyph is
          the one thing here that isn't purely decorative — it's a quick
          "which of these is bigger" read at a glance, before a visitor
          even reaches the specs list below. */}
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
        <TierGlyph memoryMb={plan.memoryMb} />
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

/** The hero band's tier glyph — a frosted-glass circle so a light icon stays legible straight on the gradient, no drop shadow needed. Sits bottom-left, clear of the badges pinned to the two top corners. */
function TierGlyph({ memoryMb }: { memoryMb: number }) {
  const Icon = tierIcon(memoryMb);
  return (
    <div className="absolute bottom-3 left-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 ring-1 ring-inset ring-white/25 backdrop-blur-sm">
      <Icon className="h-5 w-5 text-white" aria-hidden="true" strokeWidth={2} />
    </div>
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
