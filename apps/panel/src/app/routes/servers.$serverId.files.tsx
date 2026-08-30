import { createFileRoute } from '@tanstack/react-router';
import { FileManager } from '@/features/files/FileManager';

export const Route = createFileRoute('/servers/$serverId/files')({
  component: ServerFilesRoute,
});

function ServerFilesRoute() {
  const { serverId } = Route.useParams();
  return <FileManager serverId={serverId} />;
}
