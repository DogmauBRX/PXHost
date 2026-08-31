import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';

// Layout for every /client/* page. Uses requireAuth, not an admin-blocking
// guard: an admin can browse the client area freely (e.g. to see exactly
// what a customer sees) — the two areas are separated by navigation and
// authorization, not by locking admins out of the customer's own UI.
export const Route = createFileRoute('/client')({
  beforeLoad: requireAuth,
  component: ClientLayout,
});

function ClientLayout() {
  return (
    <AppShell area="client">
      <Outlet />
    </AppShell>
  );
}
