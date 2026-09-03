import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';
import { PublicShell } from '@/features/public/PublicShell';
import { LandingPage } from '@/features/public/LandingPage';

// `/` used to be a permanent dispatcher that unconditionally sent every
// visitor to /login (via requireAuth) and then on to /admin or /client.
// Commercial site decision: `/` is now the public landing page for a
// LOGGED-OUT visitor, and stays a dispatcher — unchanged — for anyone
// already authenticated, so an existing bookmark to `/` still lands a
// signed-in user exactly where it always did.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const isAdmin = useAuthStore.getState().user?.isAdmin;
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: isAdmin ? '/admin' : '/client' });
    }
  },
  component: () => (
    <PublicShell>
      <LandingPage />
    </PublicShell>
  ),
});
