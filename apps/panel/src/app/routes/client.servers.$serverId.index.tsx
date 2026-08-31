import { createFileRoute } from '@tanstack/react-router';
import { ConsolePage } from '@/features/console/ConsolePage';

export const Route = createFileRoute('/client/servers/$serverId/')({
  component: ClientServerIndexRoute,
});

function ClientServerIndexRoute() {
  const { serverId } = Route.useParams();
  return <ConsolePage serverId={serverId} />;
}
