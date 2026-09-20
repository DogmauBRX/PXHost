import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '@/features/public/PublicShell';
import { TrustCenterPage } from '@/features/public/TrustCenterPage';

export const Route = createFileRoute('/central')({
  component: () => (
    <PublicShell>
      <TrustCenterPage />
    </PublicShell>
  ),
});
