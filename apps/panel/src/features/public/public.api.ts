import { API_URL, ApiError } from '@/shared/api/client';
import type { PublicPlan } from '@/shared/api/types';

/**
 * The commercial catalog's own fetch helper — deliberately NOT `apiFetch`
 * (shared/api/client.ts). `apiFetch` attaches whatever access token
 * happens to be in memory, retries through a refresh-token dance on 401,
 * and on a truly expired session redirects the browser to `/login` —
 * every one of those is the right behavior for the authenticated panel,
 * and the wrong behavior for a page a logged-out visitor is browsing.
 * The public catalog never sends a token and never redirects on its own;
 * a failure here is just a failure, surfaced to the caller as an
 * `ApiError` the same way `apiFetch` does.
 */
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

export const listPublicPlans = () => publicFetch<PublicPlan[]>('/api/public/plans');
export const getPublicPlan = (slug: string) => publicFetch<PublicPlan>(`/api/public/plans/${encodeURIComponent(slug)}`);
