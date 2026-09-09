/** Pure formatting helpers shared by every plan-recommendation surface (client dashboard, server page, /client/plan, the admin plan list, and the public commercial site) — one place so the "80+" convention can't drift between them. */

/**
 * `min` set + `max` null → "80+" (an open-ended top tier, per the seeded
 * Avançado plan). Both null → no recommendation published at all; callers
 * should skip rendering the row entirely rather than call this.
 */
export function formatRange(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max == null) return `${min}+`;
  if (min == null && max != null) return `até ${max}`;
  return `${min}–${max}`;
}

export function formatPrice(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency });
}

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** `Plan.cpuLimitPercent` (the Docker cgroup CPU quota, 100 = one full core) shown the way a visitor thinks about it — "2 vCPU", not "200% de CPU". */
export function formatVcpu(cpuLimitPercent: number): string {
  const vcpu = cpuLimitPercent / 100;
  const value = Number.isInteger(vcpu) ? vcpu : vcpu.toFixed(1);
  return `${value} vCPU`;
}

// Mirrors the backend's own closed set (subscriptions_billing_period_check
// / plans_billing_period_check — 'none' only ever appears on Plan, never
// on a Subscription, which is always sold on a real recurring period).
const BILLING_PERIOD_LABELS: Record<string, string> = {
  monthly: 'mês',
  quarterly: 'trimestre',
  semiannual: 'semestre',
  annual: 'ano',
};

/** "/mês", "/trimestre", ... — the public site's plans span more than monthly (unlike the older client-only surfaces, which predate quarterly/semiannual/annual and still hardcode "/mês"), so every new price display goes through this instead of assuming a period. */
export function formatBillingPeriod(period: string): string {
  return BILLING_PERIOD_LABELS[period] ?? period;
}

/**
 * The "de/por" discount percentage for a plan card — `null` unless the
 * admin actually set a `compareAtPriceCents` anchor higher than the real
 * price (the API's own `plans_compare_at_price_check` CHECK constraint
 * already guarantees `compareAtPriceCents > priceCents` whenever it's
 * non-null, so this never needs to guard against a nonsensical 0% or
 * negative result). Rounded down — a card advertising "25% OFF" must
 * never overstate the real discount by rounding up.
 */
export function discountPercent(priceCents: number, compareAtPriceCents: number | null): number | null {
  if (compareAtPriceCents == null || compareAtPriceCents <= priceCents) return null;
  return Math.floor(((compareAtPriceCents - priceCents) / compareAtPriceCents) * 100);
}
