import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '@/features/schedules/SchedulesPage';

export const Route = createFileRoute('/servers/$serverId/schedules')({
  component: ServerSchedulesRoute,
});

function ServerSchedulesRoute() {
  const { serverId } = Route.useParams();
  return <SchedulesPage serverId={serverId} />;
}
