import { createFileRoute } from '@tanstack/react-router';
import { ConsolePage } from '@/features/console/ConsolePage';

export const Route = createFileRoute('/servers/$serverId/')({
  component: ServerConsoleIndex,
});

function ServerConsoleIndex() {
  const { serverId } = Route.useParams();
  return <ConsolePage serverId={serverId} />;
}
