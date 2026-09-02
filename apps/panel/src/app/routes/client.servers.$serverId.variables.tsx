import { createFileRoute } from '@tanstack/react-router';
import { VariablesPage } from '@/features/variables/VariablesPage';

export const Route = createFileRoute('/client/servers/$serverId/variables')({
  component: ClientServerVariablesRoute,
});

function ClientServerVariablesRoute() {
  const { serverId } = Route.useParams();
  return <VariablesPage serverId={serverId} />;
}
