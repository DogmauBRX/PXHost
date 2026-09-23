import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Gauge, Layers, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { listPublicPlans } from './public.api';
import { PlanCard } from './PlanCard';
import { ComparisonTable } from './ComparisonTable';
import { Seo } from './Seo';
import { Alert, EmptyState, Skeleton } from '@/ui/primitives';
import { HeroCircuitBackground } from './HeroCircuitBackground';

// Only the two periods the catalog is expected to actually sell today —
// semiannual/annual exist in the schema but aren't part of this toggle
// until there's a real reason to surface them here too.
const PERIODS = [
  { value: 'monthly', label: 'Mensal' },
  { value: 'quarterly', label: 'Trimestral' },
] as const;

export function PublicPlansPage() {
  const { data: plans, isLoading, isError, refetch } = useQuery({ queryKey: ['public-plans'], queryFn: listPublicPlans });
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['value']>('monthly');

  // A plan's billingPeriod comes straight from the catalog (PublicPlan.billingPeriod)
  // — never inferred or computed on the frontend, same "price/period is always
  // backend truth" rule every other surface on this site follows. Filtering here
  // just picks which of the catalog's own plans to show; it never fabricates a
  // quarterly price for a plan that's only sold monthly.
  const visiblePlans = useMemo(() => plans?.filter((p) => p.billingPeriod === period) ?? [], [plans, period]);
  const planGridClass = visiblePlans.length > 3 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="plans-command relative min-h-screen overflow-hidden">
      <Seo
        title="Planos"
        description="Compare os planos de hospedagem GXhost: RAM, CPU, armazenamento e recursos inclusos em cada um."
        path="/plans"
      />

      <HeroCircuitBackground className="plans-command__circuit pointer-events-none absolute inset-x-0 top-0 h-[46rem] w-full" />
      <div className="plans-command__glow" aria-hidden="true" />

      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto mb-9 max-w-3xl text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Capacidade monitorada em tempo real
          </div>
          <h1 className="text-4xl leading-tight font-bold tracking-[-0.035em] text-text sm:text-5xl lg:text-6xl">
            Escolha a potência do <span className="plans-accent-text">seu servidor.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-text-muted sm:text-lg">
            Recursos transparentes, disponibilidade calculada em tempo real e liberdade para cancelar quando quiser.
          </p>
        </div>

        <div className="mx-auto mb-12 grid max-w-2xl grid-cols-3 gap-2 sm:gap-3">
          {[
            { icon: Zap, label: 'Ativação', value: 'automática' },
            { icon: Gauge, label: 'Recursos', value: 'limites claros' },
            { icon: ShieldCheck, label: 'Ambiente', value: 'isolado' },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="plans-trust-chip rounded-xl border border-white/10 bg-white/[0.035] p-3 text-left backdrop-blur-sm sm:flex sm:items-center sm:gap-3">
              <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent sm:mb-0"><Icon className="h-4 w-4" /></span>
              <span><strong className="block text-xs text-text sm:text-sm">{label}</strong><span className="text-[0.65rem] text-text-faint sm:text-xs">{value}</span></span>
            </div>
          ))}
        </div>

        <div className="mb-10 flex justify-center">
          <div className="plans-period-switch inline-flex items-center rounded-2xl border border-white/10 bg-black/25 p-1.5 shadow-lg backdrop-blur-xl">
            <span className="ml-2 mr-1 hidden text-text-faint sm:block"><CalendarDays className="h-4 w-4" /></span>
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPeriod(p.value)}
                aria-pressed={period === p.value}
                className={`relative rounded-xl px-5 py-2 text-sm font-semibold transition-all ${
                  period === p.value ? 'bg-accent text-accent-contrast shadow-[0_7px_20px_-10px_var(--color-accent)]' : 'text-text-muted hover:bg-white/5 hover:text-text'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
              <Skeleton className="mb-3 h-5 w-2/3" />
              <Skeleton className="mb-6 h-8 w-1/2" />
              <Skeleton className="mb-2 h-4 w-full" />
              <Skeleton className="mb-2 h-4 w-full" />
              <Skeleton className="mb-6 h-4 w-3/4" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <Alert tone="fail" title="Não foi possível carregar os planos">
          <button type="button" onClick={() => void refetch()} className="mt-1 font-medium underline underline-offset-2">
            Tentar novamente
          </button>
        </Alert>
      ) : !plans || plans.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum plano disponível no momento" description="Volte em breve — estamos preparando novos planos." />
      ) : visiblePlans.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={`Nenhum plano ${period === 'monthly' ? 'mensal' : 'trimestral'} disponível no momento`}
          description="Experimente o outro período acima, ou volte em breve."
        />
      ) : (
        <>
          <div className={`grid grid-cols-1 gap-5 ${planGridClass}`}>
            {visiblePlans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>

          {visiblePlans.length > 1 && (
            <div className="mt-20">
              <div className="mb-6">
                <span className="font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">Visão detalhada</span>
                <h2 className="mt-2 text-2xl font-bold text-text sm:text-3xl">Compare recurso por recurso</h2>
                <p className="mt-2 text-sm text-text-muted">Todos os limites exibidos vêm diretamente do catálogo atual.</p>
              </div>
              <ComparisonTable plans={visiblePlans} />
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
