import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '@/features/schedules/SchedulesPage';

export const Route = createFileRoute('/admin/servers/$serverId/schedules')({
  component: AdminServerSchedulesRoute,
});

function AdminServerSchedulesRoute() {
  const { serverId } = Route.useParams();
  return <SchedulesPage serverId={serverId} />;
}
