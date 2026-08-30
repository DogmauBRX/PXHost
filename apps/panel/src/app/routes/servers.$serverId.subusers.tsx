import { createFileRoute } from '@tanstack/react-router';
import { SubusersPage } from '@/features/subusers/SubusersPage';

export const Route = createFileRoute('/servers/$serverId/subusers')({
  component: ServerSubusersRoute,
});

function ServerSubusersRoute() {
  const { serverId } = Route.useParams();
  return <SubusersPage serverId={serverId} />;
}
