import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '@/features/public/PublicShell';
import { PlanDetailPage } from '@/features/public/PlanDetailPage';

export const Route = createFileRoute('/plans/$slug')({
  component: PlanDetailRoute,
});

function PlanDetailRoute() {
  const { slug } = Route.useParams();
  return (
    <PublicShell>
      <PlanDetailPage slug={slug} />
    </PublicShell>
  );
}
