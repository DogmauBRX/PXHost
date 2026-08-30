import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { ServersPage } from '@/features/servers/ServersPage';

export const Route = createFileRoute('/servers/')({
  beforeLoad: requireAuth,
  component: () => (
    <AppShell>
      <ServersPage />
    </AppShell>
  ),
});
