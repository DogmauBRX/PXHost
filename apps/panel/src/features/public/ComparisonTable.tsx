import type { PublicPlan } from '@/shared/api/types';
import { TableWrap, Table, THead, TBody, TR, TH, TD } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice, formatVcpu } from '@/shared/format/plan';

interface Dimension {
  label: string;
  render: (plan: PublicPlan) => string | null;
}

// One row per dimension, generated dynamically from whatever the backend
// actually returned for each plan (commercial plan §6) — never a
// hardcoded per-plan column. A dimension row is dropped entirely when
// NO plan in the current catalog publishes it, rather than rendering a row
// of blank cells.
const DIMENSIONS: Dimension[] = [
  { label: 'Preço', render: (p) => `${formatPrice(p.priceCents, p.currency)}/${formatBillingPeriod(p.billingPeriod)}` },
  { label: 'Hardware', render: (p) => p.hardwareLabel },
  { label: 'RAM', render: (p) => formatMemory(p.memoryMb) },
  { label: 'CPU', render: (p) => formatVcpu(p.cpuLimitPercent) },
  { label: 'Armazenamento', render: (p) => `${formatMemory(p.diskMb)} SSD NVMe` },
  { label: 'Servidores', render: (p) => (p.maxServers != null ? String(p.maxServers) : '1') },
  { label: 'Bancos MySQL', render: (p) => (p.maxDatabases > 0 ? String(p.maxDatabases) : null) },
  { label: 'Backups', render: (p) => (p.maxBackups > 0 ? String(p.maxBackups) : null) },
  { label: 'Retenção dos backups', render: (p) => (p.maxBackups > 0 ? `${p.backupRetentionDays} dias` : null) },
  { label: 'Agendamentos', render: (p) => (p.maxSchedules > 0 ? String(p.maxSchedules) : null) },
  { label: 'Ativação após pagamento', render: () => 'Automática' },
  { label: 'Subdomínio GXHost', render: () => 'Incluído' },
];

export function ComparisonTable({ plans }: { plans: PublicPlan[] }) {
  const rows = DIMENSIONS.filter((d) => plans.some((p) => d.render(p) != null));

  return (
    <TableWrap className="plans-comparison overflow-hidden rounded-2xl border-white/10 bg-white/[0.025] shadow-[0_24px_70px_-55px_rgba(0,0,0,0.9)]">
      <Table>
        <THead>
          <TR>
            <TH>Recurso</TH>
            {plans.map((p) => (
              <TH key={p.id} className="text-right text-accent">
                {p.name}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((dim) => (
            <TR key={dim.label}>
              <TD className="font-medium text-text-muted">{dim.label}</TD>
              {plans.map((p) => (
                <TD key={p.id} className="text-right font-mono">
                  {dim.render(p) ?? '—'}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}
