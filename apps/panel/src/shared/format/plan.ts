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
