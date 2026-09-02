import { createFileRoute } from '@tanstack/react-router';
import { AddonsPage } from '@/features/addons/AddonsPage';

export const Route = createFileRoute('/admin/servers/$serverId/addons')({
  component: AdminServerAddonsRoute,
});

function AdminServerAddonsRoute() {
  const { serverId } = Route.useParams();
  return <AddonsPage serverId={serverId} />;
}
