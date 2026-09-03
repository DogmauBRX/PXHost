import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Sparkles } from 'lucide-react';
import type { PublicPlan } from '@/shared/api/types';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice, formatRange } from '@/shared/format/plan';

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
 * and the landing page's plan preview strip. Availability is rendered
 * exactly as the backend computed it (`PublicPlansService
 * .computeAvailability`) — this component never re-derives "is there
 * capacity," per the commercial plan's explicit rule that the frontend
 * must never decide that on its own.
 */
export function PlanCard({ plan, highlight = plan.isFeatured }: { plan: PublicPlan; highlight?: boolean }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const soldOut = plan.availability.status === 'sold_out';

  const players = formatRange(plan.recommendedPlayersMin, plan.recommendedPlayersMax);
  const mods = formatRange(plan.recommendedModsMin, plan.recommendedModsMax);
  const plugins = formatRange(plan.recommendedPluginsMin, plan.recommendedPluginsMax);

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
    <Link to="/register" search={{ redirect: `/checkout/${plan.slug}` }}>
      <Button variant="primary" className="w-full">
        {ctaLabel}
      </Button>
    </Link>
  );

  return (
    <Card className={`relative flex flex-col ${highlight ? 'border-accent shadow-md ring-1 ring-accent/30' : ''}`}>
      {highlight && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-contrast shadow-sm">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {plan.highlightLabel ?? 'Mais popular'}
          </span>
        </div>
      )}

      <CardHeader className="flex-col items-start gap-1 border-b-0 pb-0">
        <div className="flex w-full items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-text">{plan.name}</h3>
          <Badge tone={AVAILABILITY_TONE[plan.availability.status]}>{AVAILABILITY_LABEL[plan.availability.status]}</Badge>
        </div>
        {plan.description && <p className="text-sm text-text-muted">{plan.description}</p>}
      </CardHeader>

      <CardBody className="flex flex-1 flex-col gap-5">
        <p>
          <span className="text-3xl font-bold text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
          <span className="text-sm font-medium text-text-faint"> /{formatBillingPeriod(plan.billingPeriod)}</span>
        </p>

        <ul className="flex flex-1 flex-col gap-2 text-sm text-text">
          <SpecRow>{formatMemory(plan.memoryMb)} de RAM</SpecRow>
          <SpecRow>{plan.cpuLimitPercent}% de CPU</SpecRow>
          <SpecRow>{formatMemory(plan.diskMb)} de armazenamento</SpecRow>
          <SpecRow>{plan.maxServers != null ? `Até ${plan.maxServers} servidor(es)` : '1 servidor'}</SpecRow>
          {plan.maxBackups > 0 && <SpecRow>Até {plan.maxBackups} backups</SpecRow>}
          {players && <SpecRow>Recomendado para {players} jogadores</SpecRow>}
          {mods && <SpecRow>Suporta {mods} mods</SpecRow>}
          {plugins && <SpecRow>Suporta {plugins} plugins</SpecRow>}
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
