import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PrismaService } from '../core/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { ServersService } from '../modules/servers/servers.service';
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { canTransition, type SubscriptionStatus } from '../modules/subscriptions/subscription-status';
import { OrdersService } from '../modules/payments/orders.service';

const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // daily — order TTL and the grace period are both day-granularity concerns, same cadence partition-maintenance already uses for a comparably slow-moving job
/** How far ahead a Pix/boleto subscription's next charge is generated. */
const OFFLINE_RENEWAL_LOOKAHEAD_DAYS = 3;

/**
 * The daily billing job. Same `upsertJobScheduler` repeatable-job
 * pattern `PartitionMaintenanceProcessor` already established.
 *
 * 1. **Offline renewal**: Pix and boleto do not debit automatically,
 *    so THIS platform schedules a fresh charge for every subscription
 *    whose period is about to end
 *    (`OrdersService.createOfflineRenewalCharge`, idempotent). Card
 *    subscriptions are skipped entirely: Mercado Pago charges those
 *    itself and simply notifies us.
 * 2. **Abandoned checkout / unpaid renewal**: a `pending` Order past
 *    its own `expiresAt` stops holding the slot its `Subscription`
 *    reserved. A `plan_initial` one cancels the still-`pending`
 *    subscription (the customer never paid at all); a `plan_renewal`
 *    one moves the subscription to `past_due` — which is exactly how an
 *    unpaid Pix becomes delinquency, with no provider event needed.
 *    Never touches an order that's already `paid`/`failed`.
 * 3. **Inadimplência**: a subscription that's been `past_due` for more
 *    than `BILLING_GRACE_DAYS` gets suspended — subscription status AND
 *    the actual server, via `ServersService.suspend(..., 'billing')` so
 *    `unsuspend`'s `requireSource` guard later refuses to let a
 *    RECOVERED payment reactivate a server that was ALSO suspended for
 *    abuse in the meantime. Never deletes a server (payments plan §17).
 *
 * "How long has it been past_due" has no dedicated timestamp column —
 * derived from the most recent `SubscriptionEvent` whose `toStatus` is
 * `'past_due'`, the same append-only history `SubscriptionsService`
 * already writes on every transition.
 */
@Injectable()
export class BillingCycleProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingCycleProcessor.name);
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly servers: ServersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly orders: OrdersService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('billing-cycle', { connection: this.connection });
    await this.queue.upsertJobScheduler('billing-cycle', { every: RUN_EVERY_MS }, { name: 'run' });

    this.worker = new Worker('billing-cycle', () => this.runOnce(), { connection: this.connection });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`billing-cycle run failed: ${err.message}`);
    });
    this.logger.log('billing-cycle worker started (every 24h)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async runOnce(): Promise<void> {
    // Renewals FIRST: a subscription whose period is ending gets its
    // next charge before anything downstream considers it late.
    const renewedCount = await this.generateOfflineRenewalCharges();
    const expiredCount = await this.expireStaleOrders();
    const suspendedCount = await this.suspendOverdueSubscriptions();
    this.logger.log(
      `billing-cycle run complete: ${renewedCount} offline renewal charge(s) created, ${expiredCount} order(s) expired, ${suspendedCount} subscription(s) suspended`,
    );
  }

  /**
   * One Pix/boleto charge per subscription whose period ends inside the
   * lookahead window. Card subscriptions are excluded by
   * `paymentMethod` — Mercado Pago charges those on its own schedule.
   *
   * A failure for one subscription never aborts the run: the next daily
   * pass retries it, and the customer isn't late until their period
   * actually lapses unpaid.
   */
  private async generateOfflineRenewalCharges(): Promise<number> {
    const horizon = new Date(Date.now() + OFFLINE_RENEWAL_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    const due = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.subscription.findMany({
        where: {
          paymentMethod: { in: ['pix', 'boleto'] },
          status: { in: ['active', 'past_due'] },
          // A subscription already on its way out never gets charged
          // again — the customer asked to stop.
          cancelAtPeriodEnd: false,
          currentPeriodEndsAt: { lte: horizon },
        },
        select: { id: true },
      }),
    );

    let created = 0;
    for (const sub of due) {
      try {
        const orderId = await this.orders.createOfflineRenewalCharge(sub.id);
        if (orderId) created++;
      } catch (err) {
        this.logger.error(`offline renewal failed for subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return created;
  }

  private async expireStaleOrders(): Promise<number> {
    const staleOrders = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.order.findMany({
        where: { status: 'pending', expiresAt: { lt: new Date() } },
        select: { id: true, subscriptionId: true, kind: true },
      }),
    );

    for (const order of staleOrders) {
      await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: 'expired' } });
        if (!order.subscriptionId) return;
        const subscription = await tx.subscription.findFirst({ where: { id: order.subscriptionId } });
        if (!subscription) return;

        if (order.kind === 'plan_initial') {
          // Never paid at all — the subscription never started.
          if (canTransition(subscription.status as SubscriptionStatus, 'cancelled')) {
            await this.subscriptions.applyTransition(tx, order.subscriptionId, 'cancelled', {
              actorId: null,
              reason: 'billing-cycle: checkout abandoned (order expired)',
            });
          }
          return;
        }

        // A renewal charge that expired unpaid IS the delinquency
        // signal for an offline charge — the provider has no "overdue"
        // event to send
        // for a charge it never scheduled. From here the existing grace
        // period and suspension logic take over unchanged.
        if (canTransition(subscription.status as SubscriptionStatus, 'past_due')) {
          await this.subscriptions.applyTransition(tx, order.subscriptionId, 'past_due', {
            actorId: null,
            reason: 'billing-cycle: renewal charge expired unpaid',
          });
        }
      });
      await this.audit.record({ action: 'payment.checkout.expired', targetType: 'order', targetId: order.id });
    }

    return staleOrders.length;
  }

  private async suspendOverdueSubscriptions(): Promise<number> {
    const graceDays = this.config.get<number>('BILLING_GRACE_DAYS') ?? 3;
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    const pastDue = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.subscription.findMany({ where: { status: 'past_due' }, select: { id: true, serverId: true } }),
    );

    let suspendedCount = 0;
    for (const sub of pastDue) {
      const lastPastDueEvent = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.subscriptionEvent.findFirst({
          where: { subscriptionId: sub.id, toStatus: 'past_due' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      if (!lastPastDueEvent || lastPastDueEvent.createdAt > cutoff) continue; // still inside the grace window

      await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
        await this.subscriptions.applyTransition(tx, sub.id, 'suspended', {
          actorId: null,
          reason: `billing-cycle: past_due for more than ${graceDays} day(s)`,
        });
      });
      await this.audit.record({ action: 'subscription.suspended.billing', targetType: 'subscription', targetId: sub.id, metadata: { graceDays } });

      if (sub.serverId) {
        await this.servers.suspend(sub.serverId, `billing: past_due for more than ${graceDays} day(s)`, null, 'billing');
      }
      suspendedCount++;
    }

    return suspendedCount;
  }
}
