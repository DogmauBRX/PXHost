import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { ProvisioningService } from '../modules/payments/provisioning.service';

/**
 * Consumes jobs `ProvisioningQueueService` (running in the API process)
 * adds — the worker-side half of the payments plan's checkout pipeline.
 * `ProvisioningService.provisionOrder` does the actual work; this is
 * just the BullMQ plumbing, same shape as every other `*.processor.ts`
 * in this directory. Concurrency 3 — same figure `ServerTransferProcessor`
 * already uses for a comparably heavy, node-touching operation.
 *
 * Retries (5 attempts, exponential backoff) are configured on the JOB
 * itself by `ProvisioningQueueService.enqueue`, not here — a throw from
 * `provisionOrder` is exactly what tells BullMQ to schedule the next
 * attempt.
 */
@Injectable()
export class OrderProvisioningProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderProvisioningProcessor.name);
  private connection!: IORedis;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly provisioning: ProvisioningService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.worker = new Worker(
      'order-provisioning',
      async (job: Job<{ orderId: string }>) => {
        await this.provisioning.provisionOrder(job.data.orderId);
      },
      { connection: this.connection, concurrency: 3 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`order ${job?.data?.orderId} provisioning job failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`);
    });
    this.logger.log('order-provisioning worker started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
