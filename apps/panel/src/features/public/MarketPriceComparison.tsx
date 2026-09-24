import { useState } from 'react';
import { BarChart3, Check, Info, TrendingDown } from 'lucide-react';
import type { PublicPlan } from '@/shared/api/types';
import { formatMemory, formatPrice, formatVcpu } from '@/shared/format/plan';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/ui/primitives';

const MARKET_SAMPLE = { providers: 8, checkedAt: '24/09/2026' };

const MONTHS_PER_PERIOD: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

interface MarketProfile {
  priceMinCents: number;
  priceMaxCents: number;
  pricePerGb: string;
  cpu: string;
  disk: string;
  hardware: string;
  match: string;
}

interface ComparisonRow {
  label: string;
  gxhost: string;
  market: string;
  context: string;
}

function monthlyEquivalent(plan: PublicPlan): number {
  return Math.round(plan.priceCents / (MONTHS_PER_PERIOD[plan.billingPeriod] ?? 1));
}

// Price ranges are matched by both RAM and processor class. In particular,
// the RoxyCloud Xeon E5-2673v3 line is not used as a price floor for GXhost's
// Ryzen 9 plans; those are compared with public Ryzen 7/9 offers instead.
function marketProfile(plan: PublicPlan): MarketProfile {
  const isRyzen = plan.hardwareLabel?.toLowerCase().includes('ryzen') ?? false;

  if (isRyzen && plan.memoryMb >= 12288) {
    return {
      priceMinCents: 9490,
      priceMaxCents: 11999,
      pricePerGb: 'R$ 7,91 – R$ 10,00',
      cpu: '6–7 vCPU quando publicado',
      disk: '30–45 GB SSD/NVMe',
      hardware: 'AMD Ryzen 9 5900X a 9950X',
      match: 'Ofertas Ryzen 9 com 12–16 GB de RAM',
    };
  }

  if (isRyzen) {
    return {
      priceMinCents: 6400,
      priceMaxCents: 8490,
      pricePerGb: 'R$ 8,00 – R$ 10,61',
      cpu: '5 vCPU quando publicado',
      disk: '15–30 GB SSD/NVMe',
      hardware: 'AMD Ryzen 7 5700X a Ryzen 9 9950X',
      match: 'Ofertas Ryzen com 8 GB de RAM',
    };
  }

  const memoryGb = plan.memoryMb / 1024;
  return {
    priceMinCents: Math.round(memoryGb * 500),
    priceMaxCents: Math.round(memoryGb * 1250),
    pricePerGb: 'R$ 5,00 – R$ 12,50',
    cpu: plan.memoryMb <= 5120 ? '3–4 vCPU quando publicado' : '4 vCPU quando publicado',
    disk: plan.memoryMb <= 5120 ? '10–30 GB SSD/NVMe' : '15–30 GB SSD/NVMe',
    hardware: 'Intel Xeon E5 e linhas de processamento padrão',
    match: `Ofertas de entrada equivalentes a ${formatMemory(plan.memoryMb)} de RAM`,
  };
}

function comparisonRows(plan: PublicPlan, market: MarketProfile): ComparisonRow[] {
  const gxMonthly = monthlyEquivalent(plan);
  const memoryGb = plan.memoryMb / 1024;
  const priceRange = `${formatPrice(market.priceMinCents, plan.currency)} – ${formatPrice(market.priceMaxCents, plan.currency)}`;

  return [
    { label: 'Preço mensal', gxhost: formatPrice(gxMonthly, plan.currency), market: priceRange, context: market.match },
    {
      label: 'Preço por GB',
      gxhost: formatPrice(Math.round(gxMonthly / memoryGb), plan.currency),
      market: market.pricePerGb,
      context: 'Preço e RAM da mesma classe de hardware, sem misturar Xeon de entrada com Ryzen.',
    },
    {
      label: 'Memória RAM',
      gxhost: formatMemory(plan.memoryMb),
      market: `${formatMemory(plan.memoryMb)} como referência`,
      context: 'Planos com RAM ilimitada sem franquia numérica não são convertidos em estimativas.',
    },
    {
      label: 'CPU alocada',
      gxhost: formatVcpu(plan.cpuLimitPercent),
      market: market.cpu,
      context: 'A maioria das hosts não publica a quantidade de vCPU; mostramos apenas dados verificáveis.',
    },
    {
      label: 'Armazenamento',
      gxhost: `${formatMemory(plan.diskMb)} SSD NVMe`,
      market: market.disk,
      context: 'Faixa publicada por ofertas com RAM e processador próximos.',
    },
    {
      label: 'Processador',
      gxhost: plan.hardwareLabel ?? 'Não informado',
      market: market.hardware,
      context: 'A classe do processador faz parte do filtro de preço e desempenho.',
    },
    {
      label: 'Backups',
      gxhost: `Até ${plan.maxBackups} · ${plan.backupRetentionDays} dias`,
      market: 'Automático ou via painel em 4 de 8',
      context: 'As concorrentes raramente publicam quantidade e retenção por plano.',
    },
    {
      label: 'Bancos MySQL',
      gxhost: `Até ${plan.maxDatabases}`,
      market: 'Incluído em 4 de 8',
      context: 'As ofertas pesquisadas não publicam uma cota comparável por plano.',
    },
    {
      label: 'Agendamentos',
      gxhost: `Até ${plan.maxSchedules}`,
      market: 'Recurso citado por 2 de 8',
      context: 'Nenhuma das páginas consultadas publica um limite de tarefas.',
    },
    {
      label: 'Painel de controle',
      gxhost: 'Completo e incluso',
      market: 'Publicado por 6 de 8',
      context: 'Console e arquivos são comuns; instaladores e automações variam.',
    },
    {
      label: 'Ativação após pagamento',
      gxhost: 'Automática',
      market: 'Imediata ou automática em 4 de 8',
      context: 'Contagem baseada apenas em promessas explícitas nas páginas públicas.',
    },
    {
      label: 'Subdomínio',
      gxhost: 'Incluído',
      market: 'Explicitamente incluído em 3 de 8',
      context: 'Ausência de publicação não significa necessariamente cobrança adicional.',
    },
  ];
}

export function MarketPriceComparison({ plans }: { plans: PublicPlan[] }) {
  const [selectedSortOrder, setSelectedSortOrder] = useState(plans[0]?.sortOrder ?? 0);
  const selectedPlan = plans.find((plan) => plan.sortOrder === selectedSortOrder) ?? plans[0];
  if (!selectedPlan) return null;

  const selectedMarket = marketProfile(selectedPlan);
  const selectedMonthly = monthlyEquivalent(selectedPlan);
  const selectedSavings = Math.max(0, Math.round((1 - selectedMonthly / selectedMarket.priceMinCents) * 100));
  const rows = comparisonRows(selectedPlan, selectedMarket);

  return (
    <section className="mt-12" aria-labelledby="market-price-title">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">Comparativo de mercado</span>
          <h2 id="market-price-title" className="mt-2 text-2xl font-bold text-text sm:text-3xl">Compare preço, hardware e recursos</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
            Uma análise anônima de ofertas públicas de {MARKET_SAMPLE.providers} hosts brasileiras, aproximadas por RAM e classe de processador.
          </p>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-ok/20 bg-ok/10 px-3 py-1.5 text-xs font-semibold text-ok">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Pesquisa atualizada
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" role="tablist" aria-label="Plano usado na comparação">
        {plans.map((plan) => {
          const profile = marketProfile(plan);
          const isSelected = plan.sortOrder === selectedPlan.sortOrder;
          return (
            <button
              key={plan.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelectedSortOrder(plan.sortOrder)}
              className={`relative overflow-hidden rounded-2xl border p-4 text-left transition duration-200 ${isSelected ? 'border-accent/60 bg-accent/10 shadow-[0_16px_45px_-30px_var(--color-accent)]' : 'border-white/10 bg-white/[0.035] hover:border-accent/30 hover:bg-white/[0.055]'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div><strong className="block text-base text-text">{plan.name}</strong><span className="font-mono text-[0.7rem] text-text-faint">{formatMemory(plan.memoryMb)} · {plan.hardwareLabel}</span></div>
                <BarChart3 className={`h-4 w-4 ${isSelected ? 'text-accent' : 'text-text-faint'}`} aria-hidden="true" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div><span className="block text-[0.65rem] text-text-faint uppercase">GXhost</span><span className="text-lg font-bold text-ok">{formatPrice(monthlyEquivalent(plan), plan.currency)}</span></div>
                <div className="text-right"><span className="block text-[0.65rem] text-text-faint uppercase">Mercado similar</span><span className="font-mono text-xs font-semibold text-text-muted">{formatPrice(profile.priceMinCents, plan.currency)}–{formatPrice(profile.priceMaxCents, plan.currency)}</span></div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        <div className="flex flex-col gap-3 border-b border-white/10 bg-gradient-to-r from-accent/10 via-transparent to-ok/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div><span className="text-xs font-semibold tracking-wide text-accent uppercase">Plano selecionado</span><h3 className="mt-1 text-xl font-bold text-text">{selectedPlan.name}</h3><p className="mt-1 text-xs text-text-faint">{selectedMarket.match}</p></div>
          {selectedSavings > 0 ? (
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-sm font-semibold text-accent"><TrendingDown className="h-4 w-4" aria-hidden="true" />{selectedSavings}% abaixo do menor preço similar</div>
          ) : (
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-ok/20 bg-ok/10 px-3 py-1.5 text-sm font-semibold text-ok"><Check className="h-4 w-4" aria-hidden="true" />Preço dentro da faixa similar</div>
          )}
        </div>

        <TableWrap className="border-0 bg-transparent">
          <Table>
            <THead><TR><TH>Critério</TH><TH>GXhost</TH><TH>Mercado similar</TH><TH>Como interpretar</TH></TR></THead>
            <TBody>
              {rows.map((row) => <TR key={row.label}><TD className="font-semibold text-text">{row.label}</TD><TD className="font-mono font-semibold text-ok">{row.gxhost}</TD><TD className="font-medium text-text">{row.market}</TD><TD className="min-w-64 text-xs leading-5 text-text-faint">{row.context}</TD></TR>)}
            </TBody>
          </Table>
        </TableWrap>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/8 bg-black/15 px-4 py-3 text-xs leading-5 text-text-faint">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <p>Levantamento de {MARKET_SAMPLE.checkedAt}. Preços Ryzen são comparados somente com linhas Ryzen; ofertas Xeon de entrada não reduzem artificialmente a faixa dos planos Avançado e Ultra. RAM ilimitada sem franquia numérica e recursos não publicados não são estimados. Promoções, estoque e especificações podem mudar.</p>
      </div>
    </section>
  );
}
