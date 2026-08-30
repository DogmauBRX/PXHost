import { useAuthStore } from '../stores/auth.store';
import type { LoginResponse } from './types';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

// One refresh attempt, shared across every concurrent 401 — several
// queries can fail at once on an expired token, and they must not each
// race their own refresh call (which would rotate the refresh token
// multiple times and revoke all but the last one, per the API's
// reuse-detection design).
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<LoginResponse>) : null))
      .then((body) => {
        if (!body) return null;
        useAuthStore.getState().setAccessToken(body.accessToken);
        return body.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD', undefined]);

export async function apiFetch<T>(path: string, init: RequestInit = {}, _retried = false): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  // Fastify's JSON body parser rejects a truly empty body sent alongside
  // Content-Type: application/json ("Body cannot be empty...") — a POST
  // with no payload (e.g. minting a console token) still needs SOME body
  // when that header is set, so default to '{}' rather than omitting it.
  const body = init.body ?? (BODYLESS_METHODS.has(init.method?.toUpperCase()) ? undefined : '{}');
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    body,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401 && !_retried) {
    const newToken = await refreshAccessToken();
    if (newToken) return apiFetch<T>(path, init, true);
    useAuthStore.getState().clear();
    if (!location.pathname.startsWith('/login')) location.assign('/login');
    throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
    throw new ApiError(res.status, body.code ?? 'UNKNOWN', body.message ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
