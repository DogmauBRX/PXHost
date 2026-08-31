import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireAdmin } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';

// Layout for every /admin/* page (architecture doc roadmap M12). The tab row
// the admin pages used to carry moved into the sidebar during the redesign —
// those destinations are top-level navigation, not sub-sections of one
// screen, so a rail entry each is the honest representation. The per-server
// layout still keeps tabs, because those genuinely are facets of one server.
export const Route = createFileRoute('/admin')({
  beforeLoad: requireAdmin,
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <AppShell area="admin">
      <Outlet />
    </AppShell>
  );
}
