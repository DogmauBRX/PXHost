import { createFileRoute } from '@tanstack/react-router';
import { OrderPage } from '@/features/client/OrderPage';

export const Route = createFileRoute('/client/orders/$orderId')({
  component: ClientOrderRoute,
});

function ClientOrderRoute() {
  const { orderId } = Route.useParams();
  return <OrderPage orderId={orderId} />;
}
