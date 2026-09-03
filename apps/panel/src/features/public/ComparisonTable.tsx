import type { PublicPlan } from '@/shared/api/types';
import { TableWrap, Table, THead, TBody, TR, TH, TD } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice, formatRange } from '@/shared/format/plan';

interface Dimension {
  label: string;
  render: (plan: PublicPlan) => string | null;
}

// One row per dimension, generated dynamically from whatever the backend
// actually returned for each plan (commercial plan §6) — never a
// hardcoded per-plan column. A dimension row is dropped entirely when
// NO plan in the current catalog publishes it (e.g. no plan sets a
// recommended plugin range), rather than rendering a row of blank cells.
const DIMENSIONS: Dimension[] = [
  { label: 'Preço', render: (p) => `${formatPrice(p.priceCents, p.currency)}/${formatBillingPeriod(p.billingPeriod)}` },
  { label: 'RAM', render: (p) => formatMemory(p.memoryMb) },
  { label: 'CPU', render: (p) => `${p.cpuLimitPercent}%` },
  { label: 'Armazenamento', render: (p) => formatMemory(p.diskMb) },
  { label: 'Servidores', render: (p) => (p.maxServers != null ? String(p.maxServers) : '1') },
  { label: 'Backups', render: (p) => (p.maxBackups > 0 ? String(p.maxBackups) : null) },
  { label: 'Jogadores recomendados', render: (p) => formatRange(p.recommendedPlayersMin, p.recommendedPlayersMax) },
  { label: 'Mods recomendados', render: (p) => formatRange(p.recommendedModsMin, p.recommendedModsMax) },
  { label: 'Plugins recomendados', render: (p) => formatRange(p.recommendedPluginsMin, p.recommendedPluginsMax) },
];

export function ComparisonTable({ plans }: { plans: PublicPlan[] }) {
  const rows = DIMENSIONS.filter((d) => plans.some((p) => d.render(p) != null));

  return (
    <TableWrap>
      <Table>
        <THead>
          <TR>
            <TH>Recurso</TH>
            {plans.map((p) => (
              <TH key={p.id} className="text-right">
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
