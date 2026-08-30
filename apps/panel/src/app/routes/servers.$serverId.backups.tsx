import { createFileRoute } from '@tanstack/react-router';
import { BackupsPage } from '@/features/backups/BackupsPage';

export const Route = createFileRoute('/servers/$serverId/backups')({
  component: ServerBackupsRoute,
});

function ServerBackupsRoute() {
  const { serverId } = Route.useParams();
  return <BackupsPage serverId={serverId} />;
}
