import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';
import type { ParsedWebhook } from './payment-provider.interface';

/**
 * The API process's producer for the `webhook-processing` queue — same
 * "thin add-a-job half" shape as `ProvisioningQueueService`. This queue
 * exists specifically BECAUSE Asaas is less forgiving of a slow/failing
 * endpoint than Mercado Pago was: their own docs say the sync queue is
 * INTERRUPTED entirely after 15 consecutive non-2xx responses (new
 * events keep generating but stop being delivered until manually
 * resumed). `PaymentsWebhookController` therefore does the absolute
 * minimum synchronously (verify the token, dedupe-insert, enqueue) and
 * responds 2xx — all the actual re-fetching/state-changing work
 * (`PaymentsWebhookService.process`) happens here, off the request path,
 * where a transient failure retries without ever costing Asaas a
 * "failure" against that 15-strike counter.
 *
 * `attempts`/`backoff` mirror `ProvisioningQueueService`'s own choice —
 * a webhook this platform fails to process (a DB hiccup, Asaas briefly
 * unreachable for the mandatory re-fetch) must retry, not silently drop
 * a payment confirmation.
 */
@Injectable()
export class WebhookProcessingQueueService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private queue!: Queue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('webhook-processing', { connection: this.connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(parsed: ParsedWebhook): Promise<void> {
    // Hyphens only in the jobId — BullMQ 6.x hard-rejects ':' (the same
    // latent defect ProvisioningQueueService's own doc comment
    // documents). Deterministic per notification: enqueuing the same
    // webhook id twice (a redelivery that raced the dedupe-insert) adds
    // only ONE job.
    await this.queue.add('process', parsed, {
      jobId: `webhook-${parsed.notificationId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }
}
