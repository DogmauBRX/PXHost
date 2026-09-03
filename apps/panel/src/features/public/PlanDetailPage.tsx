import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { getPublicPlan } from './public.api';
import { PlanCard } from './PlanCard';
import { Seo } from './Seo';
import { ApiError } from '@/shared/api/client';
import { Alert, EmptyState, Skeleton } from '@/ui/primitives';

export function PlanDetailPage({ slug }: { slug: string }) {
  const {
    data: plan,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({ queryKey: ['public-plan', slug], queryFn: () => getPublicPlan(slug) });

  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <div className="mx-auto max-w-xl px-4 py-14 sm:px-6 lg:px-8">
      {plan && (
        <Seo title={plan.name} description={plan.description ?? `Conheça o plano ${plan.name} da PXHost.`} path={`/plans/${plan.slug}`} />
      )}

      <Link to="/plans" className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text">
        <ArrowLeft className="h-4 w-4" />
        Todos os planos
      </Link>

      {isLoading ? (
        <div className="rounded-card border border-border bg-surface p-5">
          <Skeleton className="mb-3 h-6 w-2/3" />
          <Skeleton className="mb-6 h-9 w-1/2" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="mb-6 h-4 w-3/4" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : notFound ? (
        <EmptyState title="Plano não encontrado" description="Esse plano pode ter sido removido ou não está mais disponível." />
      ) : isError ? (
        <Alert tone="fail" title="Não foi possível carregar este plano">
          <button type="button" onClick={() => void refetch()} className="mt-1 font-medium underline underline-offset-2">
            Tentar novamente
          </button>
        </Alert>
      ) : plan ? (
        <PlanCard plan={plan} highlight={plan.isFeatured} />
      ) : null}
    </div>
  );
}
