import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PartitionsService } from '../modules/partitions/partitions.service';

const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // daily — a rolling 3-month-ahead window tolerates missing a run by a wide margin

/**
 * "Log partition automation" (architecture doc roadmap M13) — the actual
 * automation half. PartitionsService's SQL functions do the real work;
 * this is just what calls them on a schedule, same upsertJobScheduler
 * pattern ScheduleTickProcessor already established (idempotent by
 * jobSchedulerId, so a worker restart or a second worker process never
 * creates a duplicate repeat schedule).
 */
@Injectable()
export class PartitionMaintenanceProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartitionMaintenanceProcessor.name);
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly partitions: PartitionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('partition-maintenance', { connection: this.connection });
    await this.queue.upsertJobScheduler('partition-maintenance', { every: RUN_EVERY_MS }, { name: 'maintain' });

    this.worker = new Worker('partition-maintenance', () => this.runOnce(), { connection: this.connection });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`partition maintenance run failed: ${err.message}`);
    });
    this.logger.log('partition-maintenance worker started (every 24h)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async runOnce(): Promise<void> {
    await this.partitions.ensureFuturePartitions();
    await this.partitions.archiveOldMetricPartitions();
    this.logger.log('partition maintenance run complete');
  }
}
