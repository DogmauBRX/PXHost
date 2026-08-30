import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { SchedulesService } from './schedules.service';
import { ClientServersService } from '../servers/client-servers.service';
import { BackupsService } from '../backups/backups.service';
import type { TaskAction } from './dto/schedule.dto';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The actual "run this schedule's tasks" logic (architecture doc roadmap
 * M10) — invoked by the worker process's schedule-dispatch job handler,
 * never by the HTTP API directly. Deliberately reuses ClientServersService
 * and BackupsService rather than calling AgentClient directly: an
 * unattended nightly restart+backup should behave EXACTLY like a customer
 * clicking the same buttons — same quota checks, same audit trail — not a
 * parallel code path that could silently diverge from it over time.
 */
@Injectable()
export class ScheduleRunnerService {
  private readonly logger = new Logger(ScheduleRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly clientServers: ClientServersService,
    private readonly backups: BackupsService,
  ) {}

  /**
   * Runs one already-claimed schedule (claimed and marked `is_processing`
   * by the tick handler's `FOR UPDATE SKIP LOCKED` scan) to completion,
   * then always clears `is_processing` and advances `next_run_at` — even
   * on failure, a schedule must never get stuck claimed forever, and it
   * must never fire twice for the same planned run.
   */
  async run(scheduleId: string): Promise<void> {
    const schedule = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.schedule.findFirst({
        where: { id: scheduleId },
        include: { tasks: { orderBy: { sequenceNumber: 'asc' } }, server: { include: { node: { select: { healthStatus: true } } } } },
      }),
    );
    if (!schedule) return; // deleted between being claimed and running

    // schedules.last_run_status carries a real DB CHECK constraint
    // (0001_init: schedules_last_run_status_check) allowing only
    // 'success' | 'failed' | 'skipped' — a single generic 'skipped'
    // covers both reasons below; the specific reason is logged, not
    // persisted, since the schema has no column for it.
    if (!schedule.isActive) {
      this.logger.log(`schedule ${schedule.id} skipped: inactive`);
      await this.finish(schedule.id, schedule, 'skipped');
      return;
    }
    if (schedule.onlyWhenOnline && schedule.server.node.healthStatus === 'offline') {
      this.logger.log(`schedule ${schedule.id} skipped: node offline`);
      await this.finish(schedule.id, schedule, 'skipped');
      return;
    }

    let status: 'success' | 'failed' = 'success';
    for (const task of schedule.tasks) {
      if (task.timeOffsetSeconds > 0) await sleep(task.timeOffsetSeconds * 1000);
      try {
        await this.runTask(schedule.server.ownerId, schedule.server.id, task.action as TaskAction, task.payload);
      } catch (err) {
        this.logger.warn(`schedule ${schedule.id} task ${task.id} (${task.action}) failed: ${(err as Error).message}`);
        status = 'failed';
        if (!task.continueOnFailure) break;
      }
    }
    await this.finish(schedule.id, schedule, status);
  }

  private async runTask(ownerId: string, serverId: string, action: TaskAction, payload: string): Promise<void> {
    switch (action) {
      case 'power':
        // payload selects which power verb — only 'restart' is exposed
        // by CreateTaskDto today, but AgentClient.power already supports
        // the other three, so this doesn't need to change when it is.
        await this.clientServers.power(ownerId, serverId, (payload || 'restart') as 'start' | 'stop' | 'restart' | 'kill');
        return;
      case 'backup':
        await this.backups.create(ownerId, serverId, undefined);
        return;
    }
  }

  private async finish(
    scheduleId: string,
    fields: { cronMinute: string; cronHour: string; cronDayOfMonth: string; cronMonth: string; cronDayOfWeek: string; timezone: string },
    status: 'success' | 'failed' | 'skipped',
  ): Promise<void> {
    const nextRunAt = this.schedules.computeNextRunAt(fields, fields.timezone);
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.schedule.update({ where: { id: scheduleId }, data: { isProcessing: false, lastRunAt: new Date(), lastRunStatus: status, nextRunAt } }),
    );
  }
}
