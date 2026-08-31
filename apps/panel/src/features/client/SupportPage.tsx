import { LifeBuoy } from 'lucide-react';
import { EmptyState, PageHeader } from '@/ui/primitives';

/** No ticketing system exists in this codebase — an honest "coming soon" beats a fake ticket list. */
export function SupportPage() {
  return (
    <>
      <PageHeader title="Suporte" subtitle="Abra um chamado ou fale com a equipe." />
      <EmptyState icon={LifeBuoy} title="Em breve" description="O suporte pelo painel ainda não está disponível." />
    </>
  );
}
