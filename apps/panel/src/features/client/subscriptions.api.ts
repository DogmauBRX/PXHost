import { apiFetch } from '@/shared/api/client';
import type { Subscription, SubscriptionDetail } from '@/shared/api/types';

export const listMySubscriptions = () => apiFetch<Subscription[]>('/api/client/subscriptions');
export const getMySubscription = (id: string) => apiFetch<SubscriptionDetail>(`/api/client/subscriptions/${id}`);
export const createSubscription = (planId: string) =>
  apiFetch<Subscription>('/api/client/subscriptions', { method: 'POST', body: JSON.stringify({ planId }) });
export const cancelSubscription = (id: string, reason?: string) =>
  apiFetch<Subscription>(`/api/client/subscriptions/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
