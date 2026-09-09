/**
 * Every payment provider integrated so far (Asaas's `value`, Mercado
 * Pago's `unit_price` before it) takes amounts as a DECIMAL in the
 * transaction currency, never integer cents. This is the ONLY place
 * that conversion happens; every other file in this module (and
 * everything outside it — `Order.amountCents`, `Payment.amountCents`)
 * handles integer cents only.
 */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/** Inverse of `centsToAmount` — rounds to the nearest cent to absorb float noise from a decimal amount the gateway returned. */
export function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}
