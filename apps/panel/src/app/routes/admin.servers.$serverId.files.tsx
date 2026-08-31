import { createFileRoute } from '@tanstack/react-router';
import { FileManager } from '@/features/files/FileManager';

export const Route = createFileRoute('/admin/servers/$serverId/files')({
  component: AdminServerFilesRoute,
});

function AdminServerFilesRoute() {
  const { serverId } = Route.useParams();
  return <FileManager serverId={serverId} />;
}
