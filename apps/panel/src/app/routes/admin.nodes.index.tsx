import { createFileRoute } from '@tanstack/react-router';
import { NodesPage } from '@/features/admin/NodesPage';

export const Route = createFileRoute('/admin/nodes')({
  component: NodesPage,
});
