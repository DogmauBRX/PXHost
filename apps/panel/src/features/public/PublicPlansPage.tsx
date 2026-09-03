import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { listPublicPlans } from './public.api';
import { PlanCard } from './PlanCard';
import { ComparisonTable } from './ComparisonTable';
import { Seo } from './Seo';
import { Alert, EmptyState, Skeleton } from '@/ui/primitives';

export function PublicPlansPage() {
  const { data: plans, isLoading, isError, refetch } = useQuery({ queryKey: ['public-plans'], queryFn: listPublicPlans });

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
      <Seo
        title="Planos"
        description="Compare os planos de hospedagem PXHost: RAM, CPU, armazenamento e recursos inclusos em cada um."
        path="/plans"
      />

      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h1 className="text-3xl font-bold text-text sm:text-4xl">Escolha o plano do seu servidor</h1>
        <p className="mt-3 text-base text-text-muted">
          Preços e recursos vêm direto do nosso catálogo — sem letras miúdas. Cancele quando quiser.
        </p>
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
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>

          {plans.length > 1 && (
            <div className="mt-16">
              <h2 className="mb-4 text-lg font-semibold text-text">Comparar planos</h2>
              <ComparisonTable plans={plans} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
