import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/ActivityPage';

export const Route = createFileRoute('/client/servers/$serverId/activity')({
  component: ClientServerActivityRoute,
});

function ClientServerActivityRoute() {
  const { serverId } = Route.useParams();
  return <ActivityPage serverId={serverId} />;
}
