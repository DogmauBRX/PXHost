import { createFileRoute } from '@tanstack/react-router';
import { DatabasesPage } from '@/features/databases/DatabasesPage';

export const Route = createFileRoute('/client/servers/$serverId/databases')({
  component: ClientServerDatabasesRoute,
});

function ClientServerDatabasesRoute() {
  const { serverId } = Route.useParams();
  return <DatabasesPage serverId={serverId} />;
}
