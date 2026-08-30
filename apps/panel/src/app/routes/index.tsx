import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { ServerList } from '@/features/servers/ServerList';

export const Route = createFileRoute('/')({
  beforeLoad: requireAuth,
  component: Dashboard,
});

function Dashboard() {
  return (
    <AppShell>
      <h1 className="mb-4 text-lg font-semibold text-text">Seus servidores</h1>
      <ServerList />
    </AppShell>
  );
}
