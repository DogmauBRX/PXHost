import { createFileRoute } from '@tanstack/react-router';
import { DatabasesPage } from '@/features/databases/DatabasesPage';

export const Route = createFileRoute('/servers/$serverId/databases')({
  component: ServerDatabasesRoute,
});

function ServerDatabasesRoute() {
  const { serverId } = Route.useParams();
  return <DatabasesPage serverId={serverId} />;
}
