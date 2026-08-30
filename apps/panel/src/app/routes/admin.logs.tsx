import { createFileRoute } from '@tanstack/react-router';
import { LogsPage } from '@/features/admin/LogsPage';

export const Route = createFileRoute('/admin/logs')({
  component: LogsPage,
});
