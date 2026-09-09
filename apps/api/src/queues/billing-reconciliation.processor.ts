import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PrismaService } from '../core/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../modules/payments/payment-provider.interface';

const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // daily

/**
 * The safety net for Asaas's own documented failure mode: a webhook
 * endpoint returning non-2xx 15 times in a row gets its ENTIRE
 * notification queue interrupted — new events keep generating but stop
 * being delivered until someone notices and manually resumes it in
 * Asaas's dashboard. Nothing in this platform's own code can detect
 * that from the inside (silence looks identical to "nothing happened"),
 * so this job independently asks Asaas's own API, once a day, whether
 * this platform's copy of every active/past_due subscription still
 * agrees with theirs.
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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
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
        select: { id: true, status: true, externalSubscriptionId: true },
      }),
    );

    let divergences = 0;
    for (const sub of subscriptions) {
      try {
        const remote = await this.provider.getSubscription(sub.externalSubscriptionId!);
        const remoteSuggestsActive = remote.status === 'ACTIVE';
        const localIsActive = sub.status === 'active';
        if (remoteSuggestsActive !== localIsActive) {
          divergences++;
          this.logger.warn(`reconciliation divergence: subscription ${sub.id} local=${sub.status} asaas=${remote.status}`);
          await this.audit.record({
            action: 'billing.reconciliation.divergence',
            targetType: 'subscription',
            targetId: sub.id,
            metadata: { localStatus: sub.status, remoteStatus: remote.status },
          });
        }
      } catch (err) {
        this.logger.error(`reconciliation check failed for subscription ${sub.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`billing-reconciliation run complete: ${subscriptions.length} subscription(s) checked, ${divergences} divergence(s)`);
  }
}
