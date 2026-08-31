import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/ActivityPage';

export const Route = createFileRoute('/admin/servers/$serverId/activity')({
  component: AdminServerActivityRoute,
});

function AdminServerActivityRoute() {
  const { serverId } = Route.useParams();
  return <ActivityPage serverId={serverId} />;
}
