import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '@/features/public/PublicShell';
import { CheckoutPage } from '@/features/public/CheckoutPage';

// Public, no beforeLoad guard — a visitor reaches checkout straight from
// the plans grid with no account at all. CheckoutPage itself branches on
// auth state: logged in gets a plain "confirmar assinatura," logged out
// gets the plan summary plus an inline account-creation form, so
// creating an account happens exactly at the moment of subscribing
// rather than as a separate gate before this page.
export const Route = createFileRoute('/checkout/$planSlug')({
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
