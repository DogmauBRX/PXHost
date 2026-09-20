import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '@/features/public/PublicShell';
import { TermsPage } from '@/features/public/TermsPage';

export const Route = createFileRoute('/termos')({
  component: () => (
    <PublicShell>
      <TermsPage />
    </PublicShell>
  ),
});
