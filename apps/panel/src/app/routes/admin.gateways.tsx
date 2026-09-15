import { createFileRoute } from '@tanstack/react-router';
import { GatewaysPage } from '@/features/admin/GatewaysPage';

export const Route = createFileRoute('/admin/gateways')({
  component: GatewaysPage,
});
