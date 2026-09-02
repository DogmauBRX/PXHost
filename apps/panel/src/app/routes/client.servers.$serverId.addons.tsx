import { createFileRoute } from '@tanstack/react-router';
import { AddonsPage } from '@/features/addons/AddonsPage';

export const Route = createFileRoute('/client/servers/$serverId/addons')({
  component: ClientServerAddonsRoute,
});

function ClientServerAddonsRoute() {
  const { serverId } = Route.useParams();
  return <AddonsPage serverId={serverId} />;
}
