import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '@/features/public/PublicShell';
import { PublicPlansPage } from '@/features/public/PublicPlansPage';

// Public, no beforeLoad guard — reachable logged out or logged in (see
// PublicShell's own doc comment on why a logged-in visitor may still
// want to browse the catalog).
export const Route = createFileRoute('/plans/')({
  component: () => (
    <PublicShell>
      <PublicPlansPage />
    </PublicShell>
  ),
});
