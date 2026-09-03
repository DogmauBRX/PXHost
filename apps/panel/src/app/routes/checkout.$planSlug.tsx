import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';
import { PublicShell } from '@/features/public/PublicShell';
import { CheckoutPage } from '@/features/public/CheckoutPage';

/**
 * Requires auth, but NOT via the shared `requireAuth()` guard
 * (app/guards.ts) — that one always sends an unauthenticated visitor to
 * a bare `/login` with no way back. Checkout is the one place in the
 * commercial flow (§10: "Escolher plano → Login/Cadastro → Resumo →
 * Checkout") where the visitor MUST land back on this exact URL after
 * authenticating, so this route builds its own redirect-carrying
 * `beforeLoad` instead of extending the shared guard's contract for
 * every other protected route that doesn't need it.
 */
export const Route = createFileRoute('/checkout/$planSlug')({
  beforeLoad: ({ location }) => {
    if (!useAuthStore.getState().accessToken) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: CheckoutRoute,
});

function CheckoutRoute() {
  const { planSlug } = Route.useParams();
  return (
    <PublicShell>
      <CheckoutPage planSlug={planSlug} />
    </PublicShell>
  );
}
