import { createFileRoute } from '@tanstack/react-router';
import { BackupsPage } from '@/features/backups/BackupsPage';

export const Route = createFileRoute('/admin/servers/$serverId/backups')({
  component: AdminServerBackupsRoute,
});

function AdminServerBackupsRoute() {
  const { serverId } = Route.useParams();
  return <BackupsPage serverId={serverId} />;
}
