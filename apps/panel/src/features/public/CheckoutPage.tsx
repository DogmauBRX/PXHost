import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { getPublicPlan } from './public.api';
import { createSubscription } from '@/features/client/subscriptions.api';
import { Seo } from './Seo';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Skeleton } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice } from '@/shared/format/plan';

/**
 * Commercial plan §10's "Resumo da contratação → Checkout" step. The
 * plan shown here is fetched fresh from the server (never carried
 * through router state from the plans grid) — price/limits always come
 * from the backend, the same "never trust the frontend for price"
 * doctrine `SubscriptionsService.createForUser` enforces server-side
 * (it re-reads the plan under lock regardless of anything this page
 * sends). This page's `POST` body is just `{ planId }`.
 */
export function CheckoutPage({ planSlug }: { planSlug: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const {
    data: plan,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({ queryKey: ['public-plan', planSlug], queryFn: () => getPublicPlan(planSlug) });

  const notFound = error instanceof ApiError && error.status === 404;

  async function confirm() {
    if (!plan) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createSubscription(plan.id);
      setCreated(true);
    } catch (err) {
      if (err instanceof ApiError && err.message.includes('NO_SLOTS')) {
        setSubmitError('Esse plano acabou de esgotar. Escolha outro plano ou tente novamente mais tarde.');
      } else if (err instanceof ApiError && err.message.includes('PLAN_NOT_SUBSCRIBABLE')) {
        setSubmitError('Esse plano não está disponível para contratação no momento.');
      } else if (err instanceof ApiError && err.status === 404) {
        setSubmitError('Esse plano não está mais disponível.');
      } else {
        setSubmitError(err instanceof ApiError ? err.message : 'Não foi possível concluir sua assinatura. Tente novamente.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok-tint">
          <CheckCircle2 className="h-7 w-7 text-ok" />
        </div>
        <h1 className="text-xl font-semibold text-text">Assinatura criada!</h1>
        <p className="mt-2 text-sm text-text-muted">
          Sua assinatura está <strong>pendente</strong> de confirmação. Assim que for aprovada, seu servidor será preparado pela nossa equipe.
        </p>
        <Link to="/client/subscription" className="mt-6 block">
          <Button variant="primary" className="w-full">
            Ver minha assinatura
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <Seo title="Finalizar assinatura" description="Confirme os dados do seu plano e finalize sua assinatura PXHost." />
      <h1 className="mb-6 text-xl font-semibold text-text">Resumo da contratação</h1>

      {isLoading ? (
        <Card>
          <CardBody>
            <Skeleton className="mb-3 h-5 w-1/2" />
            <Skeleton className="mb-2 h-4 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardBody>
        </Card>
      ) : notFound ? (
        <EmptyState title="Plano não encontrado" description="Esse plano pode ter sido removido. Volte à página de planos para escolher outro." />
      ) : isError ? (
        <Alert tone="fail" title="Não foi possível carregar este plano">
          <button type="button" onClick={() => void refetch()} className="mt-1 font-medium underline underline-offset-2">
            Tentar novamente
          </button>
        </Alert>
      ) : plan ? (
        <Card>
          <CardHeader>
            <CardTitle>{plan.name}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p>
              <span className="text-2xl font-bold text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
              <span className="text-sm text-text-faint"> /{formatBillingPeriod(plan.billingPeriod)}</span>
            </p>
            <ul className="space-y-1 text-sm text-text-muted">
              <li>{formatMemory(plan.memoryMb)} de RAM</li>
              <li>{plan.cpuLimitPercent}% de CPU</li>
              <li>{formatMemory(plan.diskMb)} de armazenamento</li>
            </ul>

            {plan.availability.status === 'sold_out' ? (
              <Alert tone="warn">Esse plano está esgotado no momento. Escolha outro plano na página de planos.</Alert>
            ) : (
              <>
                {submitError && <Alert>{submitError}</Alert>}
                <Button variant="primary" disabled={submitting} onClick={() => void confirm()} className="w-full">
                  {submitting ? 'Confirmando…' : 'Confirmar assinatura'}
                </Button>
                <p className="text-xs text-text-faint">
                  Sua assinatura ficará pendente até a confirmação do pagamento. Nenhuma cobrança é feita nesta etapa.
                </p>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
