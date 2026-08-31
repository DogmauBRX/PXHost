import { createFileRoute } from '@tanstack/react-router';
import { SupportPage } from '@/features/client/SupportPage';

export const Route = createFileRoute('/client/support')({
  component: SupportPage,
});
