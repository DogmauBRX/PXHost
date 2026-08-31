import { createFileRoute } from '@tanstack/react-router';
import { AdminServersPage } from '@/features/admin/AdminServersPage';

// Must be `.index.tsx`, not a bare `admin.servers.tsx` — once
// `admin.servers.$serverId.tsx` exists as a sibling, a bare `admin.servers.tsx`
// becomes an IMPLICIT LAYOUT for it in TanStack Router's flat-file convention.
// Without an <Outlet/> (this page has none — it's a leaf list view), the
// child route matches the URL but never gets anywhere to render, and the
// list silently keeps showing instead. Same bug class documented in
// servers.$serverId.tsx's own header comment, from before this rework;
// found live here the same way.
export const Route = createFileRoute('/admin/servers/')({
  component: AdminServersPage,
});
