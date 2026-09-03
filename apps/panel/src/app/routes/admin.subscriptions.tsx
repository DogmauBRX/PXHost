import { createFileRoute } from '@tanstack/react-router';
import { SubscriptionsPage } from '@/features/admin/SubscriptionsPage';

export const Route = createFileRoute('/admin/subscriptions')({
  component: SubscriptionsPage,
});
