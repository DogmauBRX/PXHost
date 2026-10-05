import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';

export const CANARY_QUEUE = 'canary';

export interface CanaryJob {
  trigger: 'schedule' | 'manual';
}

/** API-process producer: the admin's "run now" only enqueues; the worker runs it. */
@Injectable()
export class CanaryQueueService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private queue!: Queue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue(CANARY_QUEUE, { connection: this.connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async requestRun(): Promise<void> {
    await this.queue.add('run', { trigger: 'manual' } satisfies CanaryJob, { removeOnComplete: 50, removeOnFail: 50 });
  }
}
