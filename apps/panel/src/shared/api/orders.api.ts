import { apiFetch } from '@/shared/api/client';
import type { Order } from '@/shared/api/types';

// No card-token/device-fingerprint fields: card data is entered on
// MERCADO PAGO'S OWN hosted page (`Order.checkoutUrl`, their
// `init_point`), never tokenized in this frontend at all.
// `paymentMethod` alone is enough for the backend to pick the right
// Mercado Pago product — a one-off Pix charge, or a recurring card
// preapproval.
//
// No templateId/serverName/variables either, as of the post-purchase
// setup flow: the customer no longer picks software at checkout, only
// after paying — see the server's own 'setup_pending' status and
// features/servers/ServerSetupPage.tsx.
export interface CreateCheckoutInput {
  planId: string;
  paymentMethod: 'pix' | 'card';
  /** Used only by Mercado Pago as the payer; it never determines order ownership. */
  payerEmail?: string;
}

export const createCheckoutOrder = (input: CreateCheckoutInput) =>
  apiFetch<Order>('/api/client/checkout', { method: 'POST', body: JSON.stringify(input) });

export const listMyOrders = () => apiFetch<Order[]>('/api/client/orders');
export const getOrder = (id: string) => apiFetch<Order>(`/api/client/orders/${id}`);

// There is no customer-triggered renewal endpoint. A CARD subscription
// is charged by Mercado Pago's own preapproval scheduler; a PIX one is
// charged by this platform's daily billing job, which creates the next
// cycle's order and QR and surfaces it here like any other pending
// order (BillingCycleProcessor + OrdersService.createPixRenewalCharge).
// Either way the customer never asks for a charge — they just pay one.
