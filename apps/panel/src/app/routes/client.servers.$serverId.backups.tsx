import { createFileRoute } from '@tanstack/react-router';
import { BackupsPage } from '@/features/backups/BackupsPage';

export const Route = createFileRoute('/client/servers/$serverId/backups')({
  component: ClientServerBackupsRoute,
});

function ClientServerBackupsRoute() {
  const { serverId } = Route.useParams();
  return <BackupsPage serverId={serverId} />;
}
