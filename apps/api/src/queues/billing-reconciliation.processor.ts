import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PrismaService } from '../core/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { PaymentProviderRegistry } from '../modules/payments/payment-provider.registry';

const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // daily

/**
 * The safety net for a silently broken webhook. A missed notification
 * is invisible from the inside — silence looks identical to "nothing
 * happened" — so this job independently asks Mercado Pago's own API,
 * once a day, whether this platform's copy of every active/past_due
 * card subscription still agrees with theirs.
 *
 * Only card subscriptions are checked, because only they exist at
 * Mercado Pago as a preapproval. A pix subscription has no
 * provider-side object at all (Mercado Pago has no recurring pix): its
 * equivalent safety net is `BillingCycleProcessor`, which is the thing
 * generating each cycle's charge in the first place.
 *
 * Deliberately NEVER corrects a divergence automatically — logs a
 * structured warning and an audit entry (`billing.reconciliation.
 * divergence`) for a human to look at. Auto-"fixing" a payment state
 * from a background job is exactly the kind of silent financial
 * correction the payments module's own doctrine (never trust a webhook
 * body without re-fetching, never auto-refund, never auto-delete on
 * chargeback) argues against — a divergence here means something
 * upstream needs investigating, not a value to overwrite.
 */
@Injectable()
export class BillingReconciliationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconciliationProcessor.name);
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('billing-reconciliation', { connection: this.connection });
    await this.queue.upsertJobScheduler('billing-reconciliation', { every: RUN_EVERY_MS }, { name: 'run' });

    this.worker = new Worker('billing-reconciliation', () => this.runOnce(), { connection: this.connection });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`billing-reconciliation run failed: ${err.message}`);
    });
    this.logger.log('billing-reconciliation worker started (every 24h)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async runOnce(): Promise<void> {
    const subscriptions = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.subscription.findMany({
        where: { status: { in: ['active', 'past_due'] }, externalSubscriptionId: { not: null } },
        select: { id: true, status: true, externalSubscriptionId: true, paymentProvider: true },
      }),
    );

    let divergences = 0;
    for (const sub of subscriptions) {
      try {
        const provider = this.providers.get(sub.paymentProvider);
        const remote = await provider.getSubscription(sub.externalSubscriptionId!);
        const remoteSuggestsActive = provider.classifySubscription(remote) === 'SubscriptionSynced';
        const localIsActive = sub.status === 'active';
        if (remoteSuggestsActive !== localIsActive) {
          divergences++;
          this.logger.warn(`reconciliation divergence: subscription ${sub.id} local=${sub.status} ${provider.name}=${remote.status}`);
          await this.audit.record({
            action: 'billing.reconciliation.divergence',
            targetType: 'subscription',
            targetId: sub.id,
            metadata: { provider: provider.name, localStatus: sub.status, remoteStatus: remote.status },
          });
        }
      } catch (err) {
        this.logger.error(`reconciliation check failed for subscription ${sub.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`billing-reconciliation run complete: ${subscriptions.length} subscription(s) checked, ${divergences} divergence(s)`);
  }
}
