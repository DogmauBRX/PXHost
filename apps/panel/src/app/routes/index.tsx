import { createFileRoute, redirect } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { useAuthStore } from '@/shared/stores/auth.store';

// `/` is a permanent dispatcher, not a page — it never renders anything.
// This is what keeps old bookmarks/links to `/` working forever: a
// returning user (or `login.tsx`'s own "already authenticated" redirect,
// which still points here) always lands on the right area for their role
// without ever seeing an intermediate screen.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    requireAuth();
    const isAdmin = Boolean(useAuthStore.getState().user?.isAdmin);
    throw redirect({ to: isAdmin ? '/admin' : '/client' });
  },
});
