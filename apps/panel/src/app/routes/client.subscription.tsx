import { createFileRoute } from '@tanstack/react-router';
import { SubscriptionPage } from '@/features/client/SubscriptionPage';

export const Route = createFileRoute('/client/subscription')({
  component: SubscriptionPage,
});
