import { createFileRoute } from '@tanstack/react-router';
import { PlanPage } from '@/features/client/PlanPage';

export const Route = createFileRoute('/client/plan')({
  component: PlanPage,
});
