import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, Cpu, Rocket, Server, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PublicPlan } from '@/shared/api/types';
import { Badge, Button, Card, CardBody } from '@/ui/primitives';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';
import { discountPercent, formatBillingPeriod, formatMemory, formatPrice, formatVcpu } from '@/shared/format/plan';

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
  const soldOut = plan.availability.status === 'sold_out';
  const pctOff = discountPercent(plan.priceCents, plan.compareAtPriceCents);

  const ctaLabel = soldOut ? 'Esgotado' : 'Assinar plano';
  const cta = soldOut ? (
    <Button variant="secondary" disabled className="h-11 w-full rounded-xl">
      {ctaLabel}
    </Button>
  ) : (
    <Link
      to="/checkout/$planSlug"
      params={{ planSlug: plan.slug }}
      className="group flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-contrast shadow-[0_10px_28px_-14px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong"
    >
      {ctaLabel}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );

  return (
    <Card className={`plan-command-card flex flex-col overflow-hidden ${highlight ? 'plan-command-card--highlight border-accent shadow-md ring-1 ring-accent/30' : ''}`}>
      {/* Decorative brand-gradient band, same CircuitPattern motif the
          sidebar header uses (sidebar-brand__circuit). The tier glyph is
          the one thing here that isn't purely decorative — it's a quick
          "which of these is bigger" read at a glance, before a visitor
          even reaches the specs list below. */}
      <div className="plan-card-hero relative flex h-28 shrink-0 items-start justify-between p-4">
        <CircuitPattern className="plan-card-hero__circuit" />
        <div className="relative">
          {highlight && (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/25 px-2.5 py-1 text-xs font-semibold text-white shadow-sm backdrop-blur-sm">
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

      <CardBody className="flex flex-1 flex-col gap-5 p-6">
        <div>
          <h3 className="text-xl font-semibold text-text">{plan.name}</h3>
          {plan.description && <p className="mt-1.5 min-h-10 text-sm leading-5 text-text-muted">{plan.description}</p>}
        </div>

        <div>
          {pctOff != null && (
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm text-text-faint line-through">{formatPrice(plan.compareAtPriceCents!, plan.currency)}</span>
              <Badge tone="warn">{pctOff}% OFF</Badge>
            </div>
          )}
          <p>
            <span className="text-4xl font-bold tracking-tight text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
            <span className="text-sm font-medium text-text-faint"> /{formatBillingPeriod(plan.billingPeriod)}</span>
          </p>
        </div>

        <ul className="flex flex-1 flex-col gap-2.5 border-t border-white/8 pt-5 text-sm text-text">
          {plan.hardwareLabel && <SpecRow>{plan.hardwareLabel}</SpecRow>}
          <SpecRow>{formatMemory(plan.memoryMb)} de RAM</SpecRow>
          <SpecRow>{formatVcpu(plan.cpuLimitPercent)}</SpecRow>
          <SpecRow>{formatMemory(plan.diskMb)} em SSD NVMe</SpecRow>
          {plan.maxDatabases > 0 && <SpecRow>Até {plan.maxDatabases} {plan.maxDatabases === 1 ? 'banco MySQL' : 'bancos MySQL'}</SpecRow>}
          {plan.maxBackups > 0 && <SpecRow>Até {plan.maxBackups} backups · {plan.backupRetentionDays} dias</SpecRow>}
        </ul>

        <div className="mt-auto pt-1">{cta}</div>
      </CardBody>
    </Card>
  );
}

/** The hero band's tier glyph — a frosted-glass circle so a light icon stays legible straight on the gradient, no drop shadow needed. Sits bottom-left, clear of the badges pinned to the two top corners. */
function TierGlyph({ memoryMb }: { memoryMb: number }) {
  const Icon = tierIcon(memoryMb);
  return (
    <div className="absolute bottom-4 left-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/20 bg-black/20 text-white shadow-lg backdrop-blur-sm">
      <Icon className="h-5 w-5 text-white" aria-hidden="true" strokeWidth={2} />
    </div>
  );
}

function SpecRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ok/10 text-ok"><Check className="h-3.5 w-3.5" aria-hidden="true" /></span>
      <span>{children}</span>
    </li>
  );
}
