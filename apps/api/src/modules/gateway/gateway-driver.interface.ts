/**
 * The ONE seam between the GXhost core and whatever actually terminates
 * public game traffic on a VPS gateway. Same shape as
 * `PAYMENT_PROVIDER` (payments/payment-provider.interface.ts): every
 * caller depends on this interface and the `@Inject(GATEWAY_DRIVER)`
 * token, never on `HttpGatewayDriver` directly — so the nginx-stream
 * implementation can be swapped for an nftables-DNAT one later (the
 * whole reason this exists) without GatewayService or the reconciler
 * changing at all.
 *
 * A driver is deliberately dumb: it receives the FULL desired route set
 * for one gateway and makes reality match it. It never reads or writes
 * anything in Postgres — GatewayService owns the desired state, the
 * driver only ever applies it.
 */

import type { Gateway } from '@prisma/client';

export const GATEWAY_DRIVER = Symbol('GATEWAY_DRIVER');

/** One row of the desired forwarding table — everything a driver needs to open one public port and point it at one target, nothing more. */
export interface DesiredRoute {
  serverId: string;
  publicPort: number;
  protocol: 'tcp';
  targetIp: string;
  targetPort: number;
}

export interface GatewayDriver {
  /**
   * Makes the gateway's real configuration equal exactly `routes` — not
   * "add these," the full desired set every time. This is what makes
   * reconciliation idempotent by construction: running it twice with the
   * same input produces the same result, and a route missing from
   * `routes` is implicitly removed. Must throw on failure (network,
   * non-2xx, timeout) — GatewayReconcileProcessor is the only caller and
   * treats any throw as "this whole batch stayed unapplied," never
   * partial success.
   */
  apply(gateway: Gateway, routes: DesiredRoute[]): Promise<void>;
}
