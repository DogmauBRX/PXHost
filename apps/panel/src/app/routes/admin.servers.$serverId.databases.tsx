import { createFileRoute } from '@tanstack/react-router';
import { DatabasesPage } from '@/features/databases/DatabasesPage';

export const Route = createFileRoute('/admin/servers/$serverId/databases')({
  component: AdminServerDatabasesRoute,
});

function AdminServerDatabasesRoute() {
  const { serverId } = Route.useParams();
  return <DatabasesPage serverId={serverId} />;
}
