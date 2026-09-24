import { createFileRoute } from '@tanstack/react-router';
import { AboutGxPage } from '@/features/public/AboutGxPage';
import { PublicShell } from '@/features/public/PublicShell';

export const Route = createFileRoute('/sobre')({
  component: () => (
    <PublicShell>
      <AboutGxPage />
    </PublicShell>
  ),
});
