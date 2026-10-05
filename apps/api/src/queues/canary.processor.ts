import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { CanaryService } from '../modules/canary/canary.service';
import { CANARY_QUEUE, type CanaryJob } from '../modules/canary/canary-queue.service';

// 04:00 in Brazil: the quietest hour for real players, and the canary
// briefly holds a slot and some CPU on each node.
const NIGHTLY = { pattern: '0 4 * * *', tz: 'America/Sao_Paulo' };

@Injectable()
export class CanaryProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanaryProcessor.name);
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly canary: CanaryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue(CANARY_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler('canary-nightly', NIGHTLY, { name: 'run', data: { trigger: 'schedule' } satisfies CanaryJob });

    this.worker = new Worker<CanaryJob>(CANARY_QUEUE, (job) => this.canary.run(job.data.trigger), { connection: this.connection, concurrency: 1 });
    this.worker.on('failed', (_job, err) => this.logger.error(`canary run failed: ${err.message}`));
    this.logger.log('canary worker started (nightly 04:00 America/Sao_Paulo)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
