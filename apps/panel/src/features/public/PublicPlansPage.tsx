import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { listPublicPlans } from './public.api';
import { PlanCard } from './PlanCard';
import { ComparisonTable } from './ComparisonTable';
import { Seo } from './Seo';
import { Alert, EmptyState, Skeleton } from '@/ui/primitives';

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

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
      <Seo
        title="Planos"
        description="Compare os planos de hospedagem GXhost: RAM, CPU, armazenamento e recursos inclusos em cada um."
        path="/plans"
      />

      <div className="mx-auto mb-8 max-w-2xl text-center">
        <h1 className="text-3xl font-bold text-text sm:text-4xl">Escolha o plano do seu servidor</h1>
        <p className="mt-3 text-base text-text-muted">
          Preços e recursos vêm direto do nosso catálogo — sem letras miúdas. Cancele quando quiser.
        </p>
      </div>

      <div className="mb-10 flex justify-center">
        <div className="inline-flex rounded-full border border-border bg-surface-2 p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              aria-pressed={period === p.value}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                period === p.value ? 'bg-surface text-text shadow-xs' : 'text-text-muted hover:text-text'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card border border-border bg-surface p-5">
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
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visiblePlans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>

          {visiblePlans.length > 1 && (
            <div className="mt-16">
              <h2 className="mb-4 text-lg font-semibold text-text">Comparar planos</h2>
              <ComparisonTable plans={visiblePlans} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
