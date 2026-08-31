import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '@/features/schedules/SchedulesPage';

export const Route = createFileRoute('/client/servers/$serverId/schedules')({
  component: ClientServerSchedulesRoute,
});

function ClientServerSchedulesRoute() {
  const { serverId } = Route.useParams();
  return <SchedulesPage serverId={serverId} />;
}
