import { createFileRoute } from '@tanstack/react-router';
import { SupportTicketsPage } from '@/features/admin/SupportTicketsPage';

export const Route = createFileRoute('/admin/support')({
  component: SupportTicketsPage,
});
