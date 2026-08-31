import { createFileRoute } from '@tanstack/react-router';
import { BillingPage } from '@/features/client/BillingPage';

export const Route = createFileRoute('/client/billing')({
  component: BillingPage,
});
