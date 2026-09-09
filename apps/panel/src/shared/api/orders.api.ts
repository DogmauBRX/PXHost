import { apiFetch } from '@/shared/api/client';
import type { Order } from '@/shared/api/types';

// No card-token/device-fingerprint fields since the Asaas migration
// ("checkout hospedado" decision) — card data is entered on ASAAS'S OWN
// hosted checkout page (`Order.checkoutUrl`), never tokenized in this
// frontend at all. `paymentMethod` alone is enough for the backend to
// create the right kind of Asaas subscription.
export interface CreateCheckoutInput {
  planId: string;
  templateId: string;
  serverName: string;
  variables?: Record<string, string>;
  paymentMethod: 'pix' | 'card';
}

export const createCheckoutOrder = (input: CreateCheckoutInput) =>
  apiFetch<Order>('/api/client/checkout', { method: 'POST', body: JSON.stringify(input) });

export const listMyOrders = () => apiFetch<Order[]>('/api/client/orders');
export const getOrder = (id: string) => apiFetch<Order>(`/api/client/orders/${id}`);

// No more manual renewal (`POST /api/client/subscriptions/:id/renew`) —
// Asaas's own subscription scheduler generates every future charge on
// its own since the migration; this platform never calls a separate
// "renew" endpoint again (see OrdersService's own doc comment).
