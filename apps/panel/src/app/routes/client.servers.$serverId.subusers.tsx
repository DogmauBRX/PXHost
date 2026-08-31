import { createFileRoute } from '@tanstack/react-router';
import { SubusersPage } from '@/features/subusers/SubusersPage';

export const Route = createFileRoute('/client/servers/$serverId/subusers')({
  component: ClientServerSubusersRoute,
});

function ClientServerSubusersRoute() {
  const { serverId } = Route.useParams();
  return <SubusersPage serverId={serverId} />;
}
