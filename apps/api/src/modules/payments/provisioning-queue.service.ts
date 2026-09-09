import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';

/**
 * The API process's producer for the `order-provisioning` queue — same
 * shape as `TransferQueueService` (the established "thin add-a-job half,
 * importable without pulling in the consumer side" pattern in this
 * codebase). The actual work happens in `OrderProvisioningProcessor`,
 * which only runs in the worker process.
 *
 * `attempts`/`backoff` are set explicitly here — unlike every OTHER
 * queue in this codebase (none configure retry, so BullMQ's default of
 * 1 attempt applies to them), this one deliberately doesn't: a
 * transient failure (a node briefly offline, a scheduler race) must not
 * strand a customer who already paid in `provisioning_status: 'failed'`
 * on the very first hiccup. After 5 attempts exhaust, the order stays
 * `paid` with `provisioning_status: 'failed'` — the payment is never at
 * risk, only automatic provisioning stops, until an admin retries
 * (payments plan step 8) or fixes the underlying cause.
 */
@Injectable()
export class ProvisioningQueueService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private queue!: Queue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('order-provisioning', { connection: this.connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(orderId: string): Promise<void> {
    // Hyphens only — BullMQ 6.x hard-rejects a custom jobId containing
    // ':' (the exact bug TransferQueueService's own doc comment already
    // documents hitting live). A deterministic jobId per order is also
    // the queue-level half of this feature's idempotency: enqueuing the
    // same order twice (e.g. two webhook notifications about the same
    // payment, both reaching the 'activate' outcome) adds only ONE job.
    await this.queue.add(
      'provision',
      { orderId },
      {
        jobId: `provision-${orderId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
  }
}
