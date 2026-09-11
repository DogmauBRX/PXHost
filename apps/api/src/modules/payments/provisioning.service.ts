import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ServersService } from '../servers/servers.service';
import type { OrderConfigSnapshot } from './order-config-snapshot';

/**
 * Turns a PAID order into a running server — the last step of the
 * payments plan's checkout pipeline. Idempotent in the three layers the
 * plan calls for:
 *
 * 1. **Queue level**: `ProvisioningQueueService.enqueue` always uses the
 *    deterministic jobId `provision-<orderId>` — two enqueue calls for
 *    the same order collapse into one job.
 * 2. **Explicit check, here**: `order.serverId` already set, or
 *    `provisioningStatus === 'done'`, is treated as "already finished,"
 *    not re-run.
 * 3. **Database uniqueness**: `orders.server_id` and
 *    `subscriptions.server_id` are both `UNIQUE` — even a genuine race
 *    (two concurrent calls both passing check #2) fails the SECOND
 *    `ServersService.create` call's subscription-attach step on the
 *    unique constraint, rather than silently creating a second server.
 *
 * Never re-validates the template/plan against their CURRENT state
 * beyond what `ServersService.create` already checks on every call
 * (exists, not soft-deleted, `isActive`) — a template an admin
 * de-published (`isPublic: false`) AFTER this order was placed still
 * provisions: the customer already paid for exactly what `order.config`
 * snapshotted, and `isPublic` only ever gated NEW purchases, never
 * fulfillment of one already made.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly servers: ServersService,
    private readonly audit: AuditService,
  ) {}

  async provisionOrder(orderId: string): Promise<void> {
    const order = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.findFirst({ where: { id: orderId } }));
    if (!order) throw new NotFoundException('Order not found');

    if (order.serverId || order.provisioningStatus === 'done') {
      this.logger.log(`order ${orderId} already provisioned — idempotent no-op`);
      return;
    }
    if (order.provisioningStatus === 'not_required') {
      // A renewal order (payments plan step 4/5) — nothing to provision,
      // the existing server keeps running on its extended period.
      return;
    }
    if (order.status !== 'paid') {
      // Never provisions ahead of payment confirmation — this can only
      // be reached by a bug elsewhere (the webhook only ever enqueues
      // after marking the order `paid`) or a manual admin retry called
      // too early; either way, refuse loudly rather than provision for
      // free.
      throw new ConflictException(`Order ${orderId} is not paid (status=${order.status}) — refusing to provision`);
    }

    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.order.update({ where: { id: orderId }, data: { provisioningStatus: 'running', provisioningAttempts: { increment: 1 } } }),
    );

    const config = order.config as unknown as OrderConfigSnapshot;

    try {
      // Two provisioning shapes, branching on whether this order's own
      // snapshot ever collected a template — never on when the order was
      // placed. `config.template` is only present on an order created
      // before checkout stopped collecting software (CreateCheckoutDto's
      // own doc comment): that legacy shape still provisions an
      // already-`installing` server exactly as it always has. Every
      // order placed since provisions bare instead — `createSetupPending`
      // reserves the plan slot + node capacity and returns a
      // 'setup_pending' server with NO agent dispatch at all, which is
      // the entire mechanism that keeps a freshly-paid server's CPU/RAM
      // at zero until `ServerSetupService.complete` picks a software.
      // Drop this branch once no pre-existing order still carries
      // `config.template` (i.e. once every such order has either been
      // provisioned or is old enough to no longer matter).
      const created = config.template
        ? await this.servers.create({
            ownerId: order.userId,
            planId: order.planId,
            templateId: config.template.id,
            name: config.serverName ?? config.template.name,
            variables: config.variables,
            attachSubscriptionId: order.subscriptionId ?? undefined,
          })
        : await this.servers.createSetupPending({
            ownerId: order.userId,
            planId: order.planId,
            attachSubscriptionId: order.subscriptionId ?? undefined,
          });

      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.order.update({ where: { id: orderId }, data: { serverId: created.id, provisioningStatus: 'done', provisioningError: null } }),
      );
      await this.audit.record({ action: 'provisioning.succeeded', targetType: 'order', targetId: orderId, metadata: { serverId: created.id } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The payment is NEVER touched here — `order.status` stays `paid`.
      // Only `provisioningStatus`/`provisioningError` change, exactly
      // the payments plan's own rule: a provisioning failure after a
      // real payment must never look like the payment failed.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.order.update({ where: { id: orderId }, data: { provisioningStatus: 'failed', provisioningError: message.slice(0, 1000) } }),
      );
      await this.audit.record({ action: 'provisioning.failed', targetType: 'order', targetId: orderId, metadata: { error: message } });
      throw err; // BullMQ retries (up to 5x, exponential backoff — ProvisioningQueueService), then only an admin retry (payments plan step 8) tries again
    }
  }
}
