import { apiFetch } from '@/shared/api/client';
import type { LoginResponse } from '@/shared/api/types';

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function logout() {
  return apiFetch<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
}

export function forgotPassword(email: string) {
  return apiFetch<{ message: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}

export function resetPassword(token: string, newPassword: string, confirmPassword: string) {
  return apiFetch<{ message: string }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword, confirmPassword }) });
}
