import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { ScheduleRunnerService } from '../modules/schedules/schedule-runner.service';

/** Consumes jobs `schedule-tick.processor.ts` claims and hands off — actually runs each schedule's tasks (architecture doc 3.7's `schedule.dispatch` queue). */
@Injectable()
export class ScheduleDispatchProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleDispatchProcessor.name);
  private connection!: IORedis;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ScheduleRunnerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.worker = new Worker(
      'schedule-dispatch',
      async (job: Job<{ scheduleId: string }>) => {
        await this.runner.run(job.data.scheduleId);
      },
      { connection: this.connection, concurrency: 5 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`schedule ${job?.data?.scheduleId} dispatch job failed: ${err.message}`);
    });
    this.logger.log('schedule-dispatch worker started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
