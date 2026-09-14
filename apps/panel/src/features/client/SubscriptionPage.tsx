import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarClock, Layers, Settings2 } from 'lucide-react';
import { listMySubscriptions, cancelSubscription } from './subscriptions.api';
import { listMyOrders } from '@/shared/api/orders.api';
import { getServer } from '@/features/servers/servers.api';
import type { Order, Subscription, SubscriptionStatus } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, ConfirmDialog, EmptyState, LoadingRow, PageHeader } from '@/ui/primitives';
import { formatBillingPeriod, formatPrice } from '@/shared/format/plan';
import { formatDateOnly } from '@/shared/format/datetime';
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
// Terminal states never come back to life — a customer who cancels a
// plan and buys another ends up with one of these piling up per
// purchase, with nothing left to act on. Never shown here (never
// deleted either — cancelled/expired rows stay in the database as
// billing history, same "financial history is never deleted" doctrine
// `orders`/`payments` already follow — this is a display filter only).
const TERMINAL_STATUSES: SubscriptionStatus[] = ['cancelled', 'expired'];

function formatDate(value: string | null): string | null {
  return value ? formatDateOnly(value) : null;
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
  const current = useMemo(() => (subscriptions ?? []).filter((sub) => !TERMINAL_STATUSES.includes(sub.status)), [subscriptions]);
  // Only fetched to find, for a `pending` subscription, the order the
  // customer would need to get back to (the Pix QR code, or a card
  // still authorizing) — `CheckoutPage` never persists that outside its
  // own component state, so once the customer navigates away there is
  // no other way back to it than looking the order back up here.
  const { data: orders } = useQuery({ queryKey: ['my-orders'], queryFn: listMyOrders });
  const latestOrderBySubscription = new Map<string, Order>();
  for (const order of orders ?? []) {
    if (!order.subscriptionId) continue;
    const current = latestOrderBySubscription.get(order.subscriptionId);
    if (!current || order.createdAt > current.createdAt) latestOrderBySubscription.set(order.subscriptionId, order);
  }

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
      ) : current.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nenhuma assinatura ativa no momento"
          description="Escolha um plano para continuar."
          action={
            <Link to="/plans">
              <Button variant="primary">Ver planos</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {current.map((sub) => (
            <SubscriptionCard
              key={sub.id}
              sub={sub}
              orderId={latestOrderBySubscription.get(sub.id)?.id}
              onCancel={() => {
                setCancelError(null);
                setCancelTarget(sub);
              }}
            />
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

// The subscription-to-server link is only interesting for `setup_pending`/
// `install_failed` (needs the customer's attention) — for every other
// status the server's own card in `/client/servers` already covers it,
// so this fetches just to decide whether "Configurar servidor" is worth
// showing at all, not to render the server itself. Shares the exact
// `['server', serverId]` query key ServerLayout/every server page already
// use — no extra request once the customer actually opens the server.
function ServerSetupCta({ serverId }: { serverId: string }) {
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  if (!server || !['setup_pending', 'install_failed'].includes(server.status)) return null;
  return (
    <Link to="/client/servers/$serverId" params={{ serverId }}>
      <Button variant="primary" className="gap-1.5">
        <Settings2 className="h-4 w-4" aria-hidden="true" />
        Configurar servidor
      </Button>
    </Link>
  );
}

function SubscriptionCard({ sub, orderId, onCancel }: { sub: Subscription; orderId?: string; onCancel: () => void }) {
  return (
    <Card>
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
        </div>

        <div className="flex flex-wrap gap-2">
          {sub.status === 'pending' && orderId && (
            <Link to="/client/orders/$orderId" params={{ orderId }}>
              <Button variant="primary">Continuar pagamento</Button>
            </Link>
          )}
          {sub.status === 'active' && sub.serverId && <ServerSetupCta serverId={sub.serverId} />}
          {CANCELABLE_STATUSES.includes(sub.status) && (
            <Button variant="secondary" onClick={onCancel}>
              Cancelar assinatura
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
