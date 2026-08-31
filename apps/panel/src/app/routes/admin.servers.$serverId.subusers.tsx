import { createFileRoute } from '@tanstack/react-router';
import { SubusersPage } from '@/features/subusers/SubusersPage';

export const Route = createFileRoute('/admin/servers/$serverId/subusers')({
  component: AdminServerSubusersRoute,
});

function AdminServerSubusersRoute() {
  const { serverId } = Route.useParams();
  return <SubusersPage serverId={serverId} />;
}
