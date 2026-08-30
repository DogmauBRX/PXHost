import { createFileRoute } from '@tanstack/react-router';
import { AdminServersPage } from '@/features/admin/AdminServersPage';

export const Route = createFileRoute('/admin/servers')({
  component: AdminServersPage,
});
