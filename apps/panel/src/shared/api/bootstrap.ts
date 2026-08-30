import { API_URL } from './client';
import { useAuthStore } from '../stores/auth.store';
import type { LoginResponse } from './types';

/**
 * The access token lives in memory only, so a hard page refresh loses it
 * (architecture doc 5.3) — this is what re-establishes a session from the
 * HttpOnly refresh cookie the browser still holds, before the router ever
 * renders a protected route. A failure here just means "not logged in",
 * never surfaced as an error.
 */
export async function bootstrapAuth(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return;
    const body = (await res.json()) as LoginResponse;
    useAuthStore.getState().setSession(body.accessToken, {
      id: body.user.id,
      email: body.user.email,
      isAdmin: body.user.globalRole !== 'user',
    });
  } catch {
    // No session — the router's auth guard sends the user to /login.
  }
}
