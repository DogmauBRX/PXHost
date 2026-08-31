import { createFileRoute } from '@tanstack/react-router';
import { FileManager } from '@/features/files/FileManager';

export const Route = createFileRoute('/client/servers/$serverId/files')({
  component: ClientServerFilesRoute,
});

function ClientServerFilesRoute() {
  const { serverId } = Route.useParams();
  return <FileManager serverId={serverId} />;
}
