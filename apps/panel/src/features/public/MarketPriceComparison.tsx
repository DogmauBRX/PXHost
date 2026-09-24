import { BarChart3, Check, Info, TrendingDown } from 'lucide-react';
import type { PublicPlan } from '@/shared/api/types';
import { formatMemory, formatPrice } from '@/shared/format/plan';

// Public monthly offers from eight Brazilian Minecraft hosting providers,
// checked on 24/09/2026. The published comparison intentionally keeps the
// providers anonymous and normalises their advertised prices by RAM so plans
// with different memory tiers can be compared on the same basis. Offers sold
// as "unlimited RAM" without a published numeric allowance are part of the
// researched provider sample but cannot be included in the per-GB range.
const MARKET_SAMPLE = {
  providers: 8,
  checkedAt: '24/09/2026',
  minPricePerGbCents: 500,
  maxPricePerGbCents: 1250,
};

const MONTHS_PER_PERIOD: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

function monthlyEquivalent(plan: PublicPlan): number {
  return Math.round(plan.priceCents / (MONTHS_PER_PERIOD[plan.billingPeriod] ?? 1));
}

function marketRange(plan: PublicPlan): [number, number] {
  const memoryGb = plan.memoryMb / 1024;
  return [
    Math.round(memoryGb * MARKET_SAMPLE.minPricePerGbCents),
    Math.round(memoryGb * MARKET_SAMPLE.maxPricePerGbCents),
  ];
}

export function MarketPriceComparison({ plans }: { plans: PublicPlan[] }) {
  return (
    <section className="mt-12" aria-labelledby="market-price-title">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
            Comparativo de preço
          </span>
          <h2 id="market-price-title" className="mt-2 text-2xl font-bold text-text sm:text-3xl">
            Como a GXhost se posiciona no mercado
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
            Comparamos o valor mensal por GB de RAM com ofertas públicas de {MARKET_SAMPLE.providers} hosts brasileiras, sem expor marcas.
          </p>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-ok/20 bg-ok/10 px-3 py-1.5 text-xs font-semibold text-ok">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          Pesquisa atualizada
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const gxMonthly = monthlyEquivalent(plan);
          const [marketMin, marketMax] = marketRange(plan);
          const savings = Math.max(0, Math.round((1 - gxMonthly / marketMin) * 100));
          const isWithinMarketRange = gxMonthly >= marketMin && gxMonthly <= marketMax;

          return (
            <article
              key={plan.id}
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition duration-300 hover:-translate-y-1 hover:border-accent/35 hover:bg-white/[0.055]"
            >
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/80 to-transparent opacity-70" aria-hidden="true" />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-bold text-text">{plan.name}</h3>
                  <p className="mt-0.5 font-mono text-xs text-text-faint">{formatMemory(plan.memoryMb)} de RAM</p>
                </div>
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                  <BarChart3 className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>

              <div className="mt-5 rounded-xl border border-ok/15 bg-ok/[0.07] p-4">
                <span className="text-xs font-medium text-text-muted">GXhost por mês</span>
                <strong className="mt-1 block text-2xl font-bold tracking-tight text-ok">{formatPrice(gxMonthly, plan.currency)}</strong>
                {plan.billingPeriod !== 'monthly' && <span className="mt-1 block text-[0.68rem] text-text-faint">equivalente no ciclo trimestral</span>}
              </div>

              <div className="mt-4">
                <span className="text-xs font-medium text-text-muted">Faixa observada no mercado</span>
                <p className="mt-1 font-mono text-sm font-semibold text-text">
                  {formatPrice(marketMin, plan.currency)} – {formatPrice(marketMax, plan.currency)}
                </p>
              </div>

              {savings > 0 && (
                <div className="mt-4 flex items-center gap-2 border-t border-white/8 pt-4 text-sm font-semibold text-accent">
                  <TrendingDown className="h-4 w-4" aria-hidden="true" />
                  {savings}% abaixo do menor valor da faixa
                </div>
              )}
              {isWithinMarketRange && (
                <div className="mt-4 flex items-center gap-2 border-t border-white/8 pt-4 text-sm font-semibold text-ok">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Dentro da faixa observada
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/8 bg-black/15 px-4 py-3 text-xs leading-5 text-text-faint">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <p>
          Levantamento de {MARKET_SAMPLE.checkedAt}, com planos de Minecraft hospedados no Brasil e preços mensais públicos. A faixa de R$ 5,00 a R$ 12,50 por GB foi aplicada à RAM de cada plano. Ofertas com RAM ilimitada sem franquia numérica ficaram fora do cálculo. CPU, armazenamento, promoções e suporte podem variar entre provedores.
        </p>
      </div>
    </section>
  );
}
