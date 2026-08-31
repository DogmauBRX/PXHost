import { redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';

/** Typed beforeLoad guard for every protected route (architecture doc 5.1). */
export function requireAuth() {
  if (!useAuthStore.getState().accessToken) {
    throw redirect({ to: '/login' });
  }
}

/**
 * Gates the whole /admin/* route tree (architecture doc roadmap M12).
 * Client-side only — every /api/admin/* route the console actually calls
 * is independently guarded server-side by AdminGuard, so this is purely
 * UX (send a non-admin back to their own dashboard instead of a confusing
 * wall of 403s), never the real security boundary.
 *
 * The reverse is NOT guarded: /client/* only requires requireAuth, so an
 * admin can browse it freely (e.g. to see exactly what a customer sees).
 * The two areas are separated by navigation and authorization, not by
 * locking either role out of the other's UI in that direction.
 */
export function requireAdmin() {
  requireAuth();
  if (!useAuthStore.getState().user?.isAdmin) {
    throw redirect({ to: '/client' });
  }
}
