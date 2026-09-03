import { createFileRoute } from '@tanstack/react-router';
import { requireAdmin } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { NodeDetailPage } from '@/features/admin/NodeDetailPage';

// Single page, no tabs/Outlet — unlike admin.servers.$serverId.tsx this
// node view has no further drill-down sections today.
export const Route = createFileRoute('/admin/nodes/$nodeId')({
  beforeLoad: requireAdmin,
  component: NodeLayout,
});

function NodeLayout() {
  const { nodeId } = Route.useParams();
  return (
    <AppShell area="admin">
      <NodeDetailPage nodeId={nodeId} />
    </AppShell>
  );
}
