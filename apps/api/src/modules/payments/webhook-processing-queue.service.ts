import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';
import type { ParsedWebhook } from './payment-provider.interface';

export interface WebhookProcessingJob {
  provider: string;
  parsed: ParsedWebhook;
}

/**
 * The API process's producer for the `webhook-processing` queue — same
 * "thin add-a-job half" shape as `ProvisioningQueueService`.
 *
 * This queue exists so that answering Mercado Pago is never coupled to
 * doing the work. `PaymentsWebhookController` does the absolute minimum
 * synchronously (verify the signature, dedupe-insert, enqueue) and
 * responds 2xx; all the actual re-fetching and state-changing
 * (`PaymentsWebhookService.process`) happens here, off the request path.
 * Otherwise a slow database query or a transient re-fetch failure would
 * turn into a non-2xx and make Mercado Pago retry a notification it had
 * in fact already delivered successfully.
 *
 * `attempts`/`backoff` mirror `ProvisioningQueueService`'s own choice —
 * a webhook this platform fails to process (a DB hiccup, Mercado Pago
 * briefly unreachable for the mandatory re-fetch) must retry, not
 * silently drop a payment confirmation.
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

  async enqueue(provider: string, parsed: ParsedWebhook): Promise<void> {
    // Hyphens only in the jobId — BullMQ 6.x hard-rejects ':' (the same
    // latent defect ProvisioningQueueService's own doc comment
    // documents). Deterministic per notification: enqueuing the same
    // webhook id twice (a redelivery that raced the dedupe-insert) adds
    // only ONE job.
    await this.queue.add('process', { provider, parsed } satisfies WebhookProcessingJob, {
      jobId: `webhook-${provider}-${parsed.notificationId}`.replace(/:/g, '-'),
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }
}
