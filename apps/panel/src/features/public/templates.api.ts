import { API_URL, ApiError } from '@/shared/api/client';
import type { PublicTemplate } from '@/shared/api/types';

// Same unauthenticated fetch posture as public.api.ts's own
// `publicFetch` — the template catalog is part of the public checkout
// page, reachable before login, never through `apiFetch`.
async function publicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
    throw new ApiError(res.status, body.code ?? 'UNKNOWN', body.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const listPublicTemplates = () => publicFetch<PublicTemplate[]>('/api/public/templates');
