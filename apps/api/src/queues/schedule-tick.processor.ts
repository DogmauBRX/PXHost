import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { PrismaService } from '../core/prisma/prisma.service';

// 30s: frequent enough that "nightly" schedules never drift by more than
// half a minute from their computed next_run_at, without hammering
// Postgres — this is a single lightweight SELECT ... FOR UPDATE SKIP
// LOCKED against a small, indexed table, not a per-schedule poll.
const TICK_INTERVAL_MS = 30_000;

/**
 * The `schedule.tick` half of architecture doc 3.7's design: a single
 * repeatable BullMQ job that scans for due schedules and hands each one
 * off to `schedule.dispatch`. Never double-fires for two independent
 * reasons layered together: BullMQ's repeat mechanism guarantees exactly
 * one worker across however many worker PROCESSES are running picks up
 * each tick occurrence, and — the actual correctness guarantee, since a
 * single tick could in principle still race with itself if this file had
 * a bug — `FOR UPDATE SKIP LOCKED` inside a real Postgres transaction
 * means two concurrent ticks can never both claim the same due schedule;
 * one gets the row, the other's scan simply skips it.
 */
@Injectable()
export class ScheduleTickProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleTickProcessor.name);
  private connection!: IORedis;
  private tickQueue!: Queue;
  private dispatchQueue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.tickQueue = new Queue('schedule-tick', { connection: this.connection });
    this.dispatchQueue = new Queue('schedule-dispatch', { connection: this.connection });

    // upsertJobScheduler is BullMQ v6's replacement for the old
    // add(..., {repeat}) pattern — idempotent by jobSchedulerId, so
    // restarting the worker (or running two worker processes) never
    // creates a second repeat schedule for the same tick.
    await this.tickQueue.upsertJobScheduler('schedule-tick', { every: TICK_INTERVAL_MS }, { name: 'tick' });

    this.worker = new Worker('schedule-tick', () => this.tickOnce(), { connection: this.connection });
    this.logger.log(`schedule-tick worker started (every ${TICK_INTERVAL_MS}ms)`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.tickQueue?.close();
    await this.dispatchQueue?.close();
  }

  private async tickOnce(): Promise<void> {
    const due = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; next_run_at: Date }[]>`
        SELECT id, next_run_at FROM schedules
        WHERE is_active AND NOT is_processing AND next_run_at <= now()
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length > 0) {
        await tx.schedule.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { isProcessing: true } });
      }
      return rows;
    });

    for (const row of due) {
      // The deterministic jobId (architecture doc 3.7) is the second
      // independent no-double-fire guarantee: even if this exact tick
      // somehow ran twice (it can't, per the doc comment above), adding
      // a dispatch job with a jobId that already exists is a silent
      // no-op in BullMQ, not a duplicate job. Hyphens, not colons — a
      // real M13-era BullMQ (6.x) hard-rejects a custom jobId containing
      // ':' ("Custom Id cannot contain :"), a rule this queue never hit
      // in e2e coverage (which calls ScheduleRunnerService directly, not
      // through a real tick->dispatch enqueue) until node-to-node
      // transfer's own queue hit the identical bug live and this one
      // turned out to share the same latent defect.
      await this.dispatchQueue.add('dispatch', { scheduleId: row.id }, { jobId: `schedule-${row.id}-${row.next_run_at.getTime()}` });
    }
    if (due.length > 0) this.logger.log(`claimed ${due.length} due schedule(s)`);
  }
}
