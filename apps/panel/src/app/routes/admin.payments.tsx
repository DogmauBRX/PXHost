import { createFileRoute } from '@tanstack/react-router';
import { PaymentsPage } from '@/features/admin/PaymentsPage';

export const Route = createFileRoute('/admin/payments')({
  component: PaymentsPage,
});
