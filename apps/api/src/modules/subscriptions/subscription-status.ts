import { ConflictException } from '@nestjs/common';

/** Mirrors the `subscriptions_status_check` CHECK constraint (migration 0014) — the same closed set every DTO here validates against. */
export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'past_due', 'suspended', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Mirrors `subscriptions_billing_period_check` — a subscription is always priced on a real recurring period, unlike `Plan.billingPeriod`, which additionally allows `'none'` for a plan not sold on a recurring basis (see plan.dto.ts). */
export const SUBSCRIPTION_BILLING_PERIODS = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type SubscriptionBillingPeriod = (typeof SUBSCRIPTION_BILLING_PERIODS)[number];

/**
 * The subscription lifecycle (commercial plan §12): a small state
 * machine, pure and DB-free — same posture as `capacity.math.ts`'s
 * `assertNodeFits`/`nodeFitReasons` (decisions stay in plain functions,
 * DB access stays in the injectable service). Every admin-facing status
 * change and the client's own "cancel" action both go through
 * `assertTransition`, so there is exactly one place that knows which
 * moves are legal.
 *
 * `cancelled` and `expired` are terminal — no edge leaves either node.
 * `pending` can only ever become `active` (an admin turning payment on)
 * or `cancelled` (the customer, or an admin, calling it off before it
 * ever started) — it can never jump straight to `past_due`/`suspended`,
 * both of which describe a subscription that WAS billing and lapsed,
 * which `pending` by definition never was.
 */
const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  pending: ['active', 'cancelled'],
  active: ['past_due', 'suspended', 'cancelled', 'expired'],
  past_due: ['active', 'suspended', 'cancelled', 'expired'],
  suspended: ['active', 'cancelled', 'expired'],
  cancelled: [],
  expired: [],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws with an `INVALID_TRANSITION:` prefix — same "stable, greppable prefix" doctrine as `NO_CAPACITY:`/`NO_SLOTS:` in capacity.math.ts, so a future caller can distinguish this failure class from any other ConflictException without parsing prose. */
export function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`INVALID_TRANSITION: subscription is ${from}, cannot become ${to}`);
  }
}

const PERIOD_MONTHS: Record<SubscriptionBillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/**
 * The "próxima cobrança" date (commercial plan §14/§16) — computed, not
 * stored anywhere else, from whatever moment activation actually
 * happens (never the moment the subscription was CREATED, which can be
 * days earlier while `pending`). Plain UTC month arithmetic: no date
 * library exists in this codebase (checked — neither `dayjs` nor
 * `date-fns` is a dependency), and this is the only place that needs
 * one, for one calculation.
 */
export function nextPeriodEnd(from: Date, period: SubscriptionBillingPeriod): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + PERIOD_MONTHS[period]);
  return next;
}
