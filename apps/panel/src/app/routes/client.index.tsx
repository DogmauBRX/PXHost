import { createFileRoute } from '@tanstack/react-router';
import { ClientDashboardPage } from '@/features/dashboard/ClientDashboardPage';

export const Route = createFileRoute('/client/')({
  component: ClientDashboardPage,
});
