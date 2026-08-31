import { CreditCard } from 'lucide-react';
import { EmptyState, PageHeader } from '@/ui/primitives';

/** No billing/invoicing system exists in this codebase — an honest "coming soon" beats inventing fake invoices. */
export function BillingPage() {
  return (
    <>
      <PageHeader title="Faturamento" subtitle="Faturas e forma de pagamento." />
      <EmptyState icon={CreditCard} title="Em breve" description="O faturamento ainda não está disponível nesta plataforma." />
    </>
  );
}
