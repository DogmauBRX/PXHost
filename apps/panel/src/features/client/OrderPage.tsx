import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { getOrder } from '@/shared/api/orders.api';
import { OrderStatusView } from '@/shared/orders/OrderStatusView';
import { Alert, LoadingRow, PageHeader } from '@/ui/primitives';

/**
 * "Continuar pagamento" for a subscription stuck `pending` — the only
 * place a customer can get back to a Pix QR code (or a still-authorizing
 * card) after leaving `CheckoutPage` before it resolved. `SubscriptionPage`
 * links here for exactly that case; see its own comment on how it finds
 * the right order.
 */
export function OrderPage({ orderId }: { orderId: string }) {
  const navigate = useNavigate();

  const {
    data: order,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });

  return (
    <>
      <PageHeader title="Pagamento" subtitle="Acompanhe o status do seu pedido." />
      {isLoading ? (
        <LoadingRow />
      ) : isError || !order ? (
        <Alert tone="fail">Não foi possível carregar este pedido.</Alert>
      ) : (
        <OrderStatusView order={order} onRetry={() => void navigate({ to: '/plans' })} />
      )}
    </>
  );
}
