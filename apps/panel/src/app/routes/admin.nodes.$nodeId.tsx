import { createFileRoute } from '@tanstack/react-router';
import { requireAdmin } from '@/app/guards';
import { NodeDetailPage } from '@/features/admin/NodeDetailPage';

// Single page, no tabs/Outlet — unlike admin.servers.$serverId.tsx this
// node view has no further drill-down sections today.
//
// This route nests under /admin (admin.tsx's own <AppShell>) — it must
// NOT wrap in a second one itself, or the whole shell doubles (two
// Sidebars, two Topbars, two theme-toggle buttons) — the exact bug found
// and fixed on client.servers.$serverId.tsx and admin.servers.$serverId.tsx.
export const Route = createFileRoute('/admin/nodes/$nodeId')({
  beforeLoad: requireAdmin,
  component: NodeLayout,
});

function NodeLayout() {
  const { nodeId } = Route.useParams();
  return <NodeDetailPage nodeId={nodeId} />;
}
