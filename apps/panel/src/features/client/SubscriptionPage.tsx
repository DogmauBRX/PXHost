import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarClock, Layers } from 'lucide-react';
import { listMySubscriptions, cancelSubscription } from './subscriptions.api';
import type { Subscription, SubscriptionStatus } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, ConfirmDialog, EmptyState, LoadingRow, PageHeader } from '@/ui/primitives';
import { formatBillingPeriod, formatPrice } from '@/shared/format/plan';
import { ApiError } from '@/shared/api/client';

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  pending: 'Pendente',
  active: 'Ativo',
  past_due: 'Pagamento atrasado',
  suspended: 'Suspenso',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};
const STATUS_TONE: Record<SubscriptionStatus, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  pending: 'warn',
  active: 'ok',
  past_due: 'warn',
  suspended: 'fail',
  cancelled: 'neutral',
  expired: 'neutral',
};
const CANCELABLE_STATUSES: SubscriptionStatus[] = ['pending', 'active', 'past_due', 'suspended'];

function formatDate(value: string | null): string | null {
  return value ? new Date(value).toLocaleDateString('pt-BR') : null;
}

/**
 * "Minha assinatura" (commercial plan §14/§16) — replaces the previous
 * "Faturamento" screen, which was a permanent, honest "coming soon"
 * because no billing/subscription system existed yet (see BillingPage's
 * own doc comment, now removed). It does now.
 */
export function SubscriptionPage() {
  const queryClient = useQueryClient();
  const [cancelTarget, setCancelTarget] = useState<Subscription | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const { data: subscriptions, isLoading, isError, refetch } = useQuery({ queryKey: ['my-subscriptions'], queryFn: listMySubscriptions });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelSubscription(id),
    onSuccess: () => {
      setCancelTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['my-subscriptions'] });
    },
    onError: (err) => setCancelError(err instanceof ApiError ? err.message : 'Não foi possível cancelar a assinatura. Tente novamente.'),
  });

  return (
    <>
      <PageHeader title="Minha Assinatura" subtitle="Plano contratado, status e histórico." />

      {isLoading ? (
        <LoadingRow />
      ) : isError ? (
        <Alert tone="fail" title="Não foi possível carregar sua assinatura">
          <button type="button" onClick={() => void refetch()} className="mt-1 font-medium underline underline-offset-2">
            Tentar novamente
          </button>
        </Alert>
      ) : !subscriptions || subscriptions.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Você ainda não tem uma assinatura"
          description="Escolha um plano para começar."
          action={
            <Link to="/plans">
              <Button variant="primary">Ver planos</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {subscriptions.map((sub) => (
            <Card key={sub.id}>
              <CardHeader>
                <div>
                  <CardTitle>{sub.plan.name}</CardTitle>
                  <p className="mt-1 text-2xl font-semibold text-text">
                    {formatPrice(sub.priceCents, sub.currency)}
                    <span className="text-sm font-normal text-text-faint"> /{formatBillingPeriod(sub.billingPeriod)}</span>
                  </p>
                </div>
                <Badge tone={STATUS_TONE[sub.status]}>{STATUS_LABEL[sub.status]}</Badge>
              </CardHeader>
              <CardBody className="space-y-3">
                <div className="space-y-1 text-sm text-text-muted">
                  {formatDate(sub.startedAt) && (
                    <p>
                      Início: <span className="text-text">{formatDate(sub.startedAt)}</span>
                    </p>
                  )}
                  {sub.status === 'active' && formatDate(sub.currentPeriodEndsAt) && (
                    <p>
                      Próxima cobrança: <span className="text-text">{formatDate(sub.currentPeriodEndsAt)}</span>
                    </p>
                  )}
                  {sub.status === 'pending' && <p>Aguardando confirmação do pagamento.</p>}
                  {sub.status === 'cancelled' && formatDate(sub.cancelledAt) && (
                    <p>
                      Cancelado em: <span className="text-text">{formatDate(sub.cancelledAt)}</span>
                    </p>
                  )}
                </div>

                {CANCELABLE_STATUSES.includes(sub.status) && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCancelError(null);
                      setCancelTarget(sub);
                    }}
                  >
                    Cancelar assinatura
                  </Button>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8">
        <Link to="/plans" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text">
          <Layers className="h-4 w-4" />
          Ver outros planos
        </Link>
      </div>

      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancelar assinatura"
        message={`Tem certeza que deseja cancelar sua assinatura do plano "${cancelTarget?.plan.name}"? Essa ação não pode ser desfeita.`}
        confirmLabel="Cancelar assinatura"
        tone="danger"
        loading={cancelMutation.isPending}
        onConfirm={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
        onCancel={() => setCancelTarget(null)}
      />
      {cancelError && (
        <div className="fixed inset-x-0 bottom-4 mx-auto w-fit">
          <Alert tone="fail" onDismiss={() => setCancelError(null)}>
            {cancelError}
          </Alert>
        </div>
      )}
    </>
  );
}
