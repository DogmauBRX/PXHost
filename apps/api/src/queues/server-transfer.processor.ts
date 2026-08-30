import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { TransfersService } from '../modules/transfers/transfers.service';

/**
 * Consumes jobs TransferQueueService (running in the API process) adds —
 * the worker-side half of architecture doc roadmap M13's "live
 * node-to-node transfer." TransfersService.runPipeline does the actual
 * work; this is just the BullMQ plumbing, same shape as every other
 * *.processor.ts in this directory.
 */
@Injectable()
export class ServerTransferProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServerTransferProcessor.name);
  private connection!: IORedis;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly transfers: TransfersService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.worker = new Worker(
      'server-transfer',
      async (job: Job<{ transferId: string }>) => {
        await this.transfers.runPipeline(job.data.transferId);
      },
      { connection: this.connection, concurrency: 3 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`transfer ${job?.data?.transferId} pipeline job failed: ${err.message}`);
    });
    this.logger.log('server-transfer worker started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
