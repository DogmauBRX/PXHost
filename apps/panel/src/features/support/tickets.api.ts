import { apiFetch } from '@/shared/api/client';
import type {
  SupportTicketCategory,
  SupportTicketDetail,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportTicketSummary,
} from '@/shared/api/types';

export interface CreateSupportTicketInput {
  subject: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  serverId?: string;
  message: string;
}

export const listClientTickets = () => apiFetch<SupportTicketSummary[]>('/api/client/support/tickets');
export const getClientTicket = (id: string) => apiFetch<SupportTicketDetail>(`/api/client/support/tickets/${id}`);
export const createClientTicket = (input: CreateSupportTicketInput) =>
  apiFetch<SupportTicketDetail>('/api/client/support/tickets', { method: 'POST', body: JSON.stringify(input) });
export const replyClientTicket = (id: string, message: string) =>
  apiFetch<SupportTicketDetail>(`/api/client/support/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) });

export interface AdminTicketFilters {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  q?: string;
}

function queryString(filters: AdminTicketFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.q) params.set('q', filters.q);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const listAdminTickets = (filters: AdminTicketFilters = {}) =>
  apiFetch<SupportTicketSummary[]>(`/api/admin/support/tickets${queryString(filters)}`);
export const getAdminTicket = (id: string) => apiFetch<SupportTicketDetail>(`/api/admin/support/tickets/${id}`);
export const replyAdminTicket = (id: string, message: string) =>
  apiFetch<SupportTicketDetail>(`/api/admin/support/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
export const updateAdminTicket = (id: string, input: { status?: SupportTicketStatus; priority?: SupportTicketPriority }) =>
  apiFetch<SupportTicketDetail>(`/api/admin/support/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
