import { apiFetch } from '@/shared/api/client';
import type { LoginResponse } from '@/shared/api/types';

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

// Commercial site — public self-signup. Returns the exact same shape as
// login() (a real session, not just "account created — now log in"), so
// the checkout flow can go straight from "create account" into
// "subscribe" without a second round trip. 404s if the deployment has
// ALLOW_PUBLIC_REGISTRATION off (AuthService.register's own doc
// comment) — RegisterForm treats that the same as any other server
// error, since a visitor has no way to act on "this feature is
// disabled" differently than any other failure.
export function register(input: { name: string; email: string; password: string; confirmPassword: string }) {
  return apiFetch<LoginResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
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
