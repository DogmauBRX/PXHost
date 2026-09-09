import { apiFetch } from '@/shared/api/client';
import type { ClientAccount } from '@/shared/api/types';

export const getAccount = () => apiFetch<ClientAccount>('/api/client/account');

export interface UpdateAccountInput {
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string;
  currentPassword?: string;
  cpf?: string;
  billingPostalCode?: string;
  billingAddressLine?: string;
  billingAddressNumber?: string;
  billingAddressComplement?: string;
  billingNeighborhood?: string;
  billingCity?: string;
  billingState?: string;
}
export const updateAccount = (input: UpdateAccountInput) => apiFetch<ClientAccount>('/api/client/account', { method: 'PATCH', body: JSON.stringify(input) });

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}
export const changePassword = (input: ChangePasswordInput) => apiFetch<{ message: string }>('/api/client/account/change-password', { method: 'POST', body: JSON.stringify(input) });
