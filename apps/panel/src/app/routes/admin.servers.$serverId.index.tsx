import { createFileRoute } from '@tanstack/react-router';
import { ConsolePage } from '@/features/console/ConsolePage';

export const Route = createFileRoute('/admin/servers/$serverId/')({
  component: AdminServerIndexRoute,
});

function AdminServerIndexRoute() {
  const { serverId } = Route.useParams();
  return <ConsolePage serverId={serverId} />;
}
