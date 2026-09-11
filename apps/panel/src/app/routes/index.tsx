import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { useAuthStore } from '@/shared/stores/auth.store';
import { PublicShell } from '@/features/public/PublicShell';
import { LandingPage } from '@/features/public/LandingPage';

// `/` serves two callers that need OPPOSITE behavior from an
// authenticated visitor:
//  - login.tsx's own fallback (`redirect: search.redirect ?? '/'`) and a
//    plain bookmark to `/` both want the historical dispatcher behavior:
//    land a signed-in visitor straight on their dashboard.
//  - PublicShell's logo and "Início" nav link want a signed-in CUSTOMER
//    to actually see the marketing landing page when they click Home —
//    the same page a logged-out visitor gets, just with the header's CTA
//    swapped to "Ir para o painel" (PublicShell's own doc comment already
//    promised this). Found live: without an opt-out, EVERY click on
//    Início or the logo while logged in just bounced straight back to
//    /client — there was no way for an authenticated customer to ever
//    see this page again, which is exactly the bug PublicShell's comment
//    claimed didn't exist.
// `stay=1` is how a caller opts into the second behavior; absent (the
// dispatcher's own default, and every entry point except those two nav
// links) means the first, unchanged.
const searchSchema = z.object({
  stay: z.coerce.boolean().optional(),
});

export const Route = createFileRoute('/')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (search.stay) return;
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
