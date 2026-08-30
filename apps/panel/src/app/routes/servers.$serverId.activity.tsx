import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/ActivityPage';

export const Route = createFileRoute('/servers/$serverId/activity')({
  component: ServerActivityRoute,
});

function ServerActivityRoute() {
  const { serverId } = Route.useParams();
  return <ActivityPage serverId={serverId} />;
}
