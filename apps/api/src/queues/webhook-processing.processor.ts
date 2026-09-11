import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PaymentsWebhookService } from '../modules/payments/payments-webhook.service';
import type { ParsedWebhook } from '../modules/payments/payment-provider.interface';

/**
 * Consumes jobs `WebhookProcessingQueueService` (API process) adds —
 * see that class's own doc comment for why this queue exists at all
 * (answering Mercado Pago must never be coupled to doing the work, or a
 * slow query turns into a redelivery).
 * `PaymentsWebhookService.process` does the actual re-fetch/apply-
 * outcome work; this is just the BullMQ plumbing.
 *
 * Concurrency 3 — matches `OrderProvisioningProcessor`'s own figure for
 * a comparably external-API-bound operation. Retries (5 attempts,
 * exponential backoff) are configured on the JOB by the producer, not
 * here — a throw from `process` is exactly what tells BullMQ to
 * schedule the next attempt.
 */
@Injectable()
export class WebhookProcessingProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookProcessingProcessor.name);
  private connection!: IORedis;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly webhook: PaymentsWebhookService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.worker = new Worker(
      'webhook-processing',
      async (job: Job<ParsedWebhook>) => {
        await this.webhook.process(job.data);
      },
      { connection: this.connection, concurrency: 3 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`webhook ${job?.data?.notificationId} processing failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`);
    });
    this.logger.log('webhook-processing worker started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
