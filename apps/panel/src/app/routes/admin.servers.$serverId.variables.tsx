import { createFileRoute } from '@tanstack/react-router';
import { VariablesPage } from '@/features/variables/VariablesPage';

export const Route = createFileRoute('/admin/servers/$serverId/variables')({
  component: AdminServerVariablesRoute,
});

function AdminServerVariablesRoute() {
  const { serverId } = Route.useParams();
  return <VariablesPage serverId={serverId} />;
}
