import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';

/**
 * The API process's producer for the `server-transfer` queue — the
 * ACTUAL work happens in ServerTransferProcessor, which only ever runs
 * in the worker process (architecture doc 3.7: a real archive can take
 * far longer than a request should ever block on). This is the thin
 * "add a job" half, importable from a controller/service running in the
 * HTTP API without pulling in the consumer side.
 */
@Injectable()
export class TransferQueueService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private queue!: Queue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('server-transfer', { connection: this.connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(transferId: string): Promise<void> {
    // Hyphen, not colon: BullMQ 6.x hard-rejects a custom jobId containing
    // ':' ("Custom Id cannot contain :") — found live the first time this
    // ever ran for real. See schedule-tick.processor.ts's matching fix;
    // the same rule broke that queue's jobId too, just never yet
    // exercised for real by anything in this repo's e2e coverage.
    await this.queue.add('transfer', { transferId }, { jobId: `transfer-${transferId}` });
  }
}
