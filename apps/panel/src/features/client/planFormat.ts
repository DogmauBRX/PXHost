/** Pure formatting helpers shared by every plan-recommendation surface (client dashboard, server page, /client/plan, and the admin plan list) — one place so the "80+" convention can't drift between them. */

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
