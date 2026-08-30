import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';

export const Route = createFileRoute('/')({
  beforeLoad: requireAuth,
  component: () => (
    <AppShell>
      <DashboardPage />
    </AppShell>
  ),
});
