import { createFileRoute } from '@tanstack/react-router';
import { PlansPage } from '@/features/admin/PlansPage';

export const Route = createFileRoute('/admin/plans')({
  component: PlansPage,
});
