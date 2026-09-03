import { createFileRoute } from '@tanstack/react-router';
import { NodesPage } from '@/features/admin/NodesPage';

// Must be `.index.tsx`, not a bare `admin.nodes.tsx` — see
// admin.servers.index.tsx's identical comment: once
// `admin.nodes.$nodeId.tsx` exists as a sibling, a bare `admin.nodes.tsx`
// becomes an IMPLICIT LAYOUT for it. Without an <Outlet/> (this page has
// none — it's a leaf list view), the child route matches the URL but
// never gets anywhere to render, and the list silently keeps showing
// instead. Found live the exact same way servers.$serverId.tsx's history
// records.
export const Route = createFileRoute('/admin/nodes/')({
  component: NodesPage,
});
