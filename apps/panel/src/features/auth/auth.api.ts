import { apiFetch } from '@/shared/api/client';
import type { LoginResponse } from '@/shared/api/types';

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function logout() {
  return apiFetch<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
}
