import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/app/guards';
import { AppShell } from '@/ui/layout/AppShell';
import { SettingsPage } from '@/features/settings/SettingsPage';

export const Route = createFileRoute('/settings')({
  beforeLoad: requireAuth,
  component: () => (
    <AppShell>
      <SettingsPage />
    </AppShell>
  ),
});
