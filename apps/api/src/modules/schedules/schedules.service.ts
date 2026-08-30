import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { ServerAccessService } from '../authorization/server-access.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import { CreateScheduleDto, CreateTaskDto, UpdateScheduleDto } from './dto/schedule.dto';

@Injectable()
export class SchedulesService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  /** Computes the next UTC fire time from the 5 cron fields + IANA timezone — throws BadRequestException on anything cron-parser can't parse, so a schedule that could never fire is rejected at create/update time, not silently stored inert. */
  computeNextRunAt(fields: { cronMinute: string; cronHour: string; cronDayOfMonth: string; cronMonth: string; cronDayOfWeek: string }, timezone: string, from: Date = new Date()): Date {
    const expr = `${fields.cronMinute} ${fields.cronHour} ${fields.cronDayOfMonth} ${fields.cronMonth} ${fields.cronDayOfWeek}`;
    try {
      const parsed = CronExpressionParser.parse(expr, { tz: timezone, currentDate: from });
      return parsed.next().toDate();
    } catch (err) {
      throw new BadRequestException(`Invalid schedule: ${(err as Error).message}`);
    }
  }

  async list(userId: string, serverId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('schedule.read')) throw new ForbiddenException('Missing permission: schedule.read');
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.schedule.findMany({
        where: { serverId: server.id },
        include: { tasks: { orderBy: { sequenceNumber: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  private async getOwned(userId: string, serverId: string, scheduleId: string, requiredPermission: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can(requiredPermission)) throw new ForbiddenException(`Missing permission: ${requiredPermission}`);
    const schedule = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.schedule.findFirst({ where: { id: scheduleId, serverId: server.id }, include: { tasks: { orderBy: { sequenceNumber: 'asc' } } } }),
    );
    if (!schedule) throw new NotFoundException('Schedule not found');
    return { server, schedule };
  }

  async create(userId: string, serverId: string, dto: CreateScheduleDto) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('schedule.create')) throw new ForbiddenException('Missing permission: schedule.create');

    const existingCount = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.schedule.count({ where: { serverId: server.id } }));
    if (existingCount >= server.maxSchedules) {
      throw new ConflictException('Schedule limit reached for this server’s plan');
    }

    const fields = {
      cronMinute: dto.cronMinute ?? '*',
      cronHour: dto.cronHour ?? '*',
      cronDayOfMonth: dto.cronDayOfMonth ?? '*',
      cronMonth: dto.cronMonth ?? '*',
      cronDayOfWeek: dto.cronDayOfWeek ?? '*',
    };
    const timezone = dto.timezone ?? 'America/Sao_Paulo';
    const nextRunAt = this.computeNextRunAt(fields, timezone);

    const created = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.schedule.create({
        data: {
          serverId: server.id,
          name: dto.name,
          ...fields,
          timezone,
          isActive: dto.isActive ?? true,
          onlyWhenOnline: dto.onlyWhenOnline ?? false,
          nextRunAt,
        },
        include: { tasks: true },
      }),
    );
    await this.audit.record({ action: 'server.schedule.create', targetType: 'server', targetId: server.id, actorId: userId, metadata: { scheduleId: created.id } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.schedule.create', properties: { scheduleId: created.id, name: created.name } });
    return created;
  }

  async update(userId: string, serverId: string, scheduleId: string, dto: UpdateScheduleDto) {
    const { server, schedule } = await this.getOwned(userId, serverId, scheduleId, 'schedule.update');

    const fields = {
      cronMinute: dto.cronMinute ?? schedule.cronMinute,
      cronHour: dto.cronHour ?? schedule.cronHour,
      cronDayOfMonth: dto.cronDayOfMonth ?? schedule.cronDayOfMonth,
      cronMonth: dto.cronMonth ?? schedule.cronMonth,
      cronDayOfWeek: dto.cronDayOfWeek ?? schedule.cronDayOfWeek,
    };
    const timezone = dto.timezone ?? schedule.timezone;
    // Recomputed unconditionally: even a change to just isActive/onlyWhenOnline
    // is cheap to recompute and guarantees nextRunAt is never stale relative
    // to whatever cron/timezone fields the row actually carries right now.
    const nextRunAt = this.computeNextRunAt(fields, timezone);

    const updated = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.schedule.update({
        where: { id: schedule.id },
        data: { name: dto.name, ...fields, timezone, isActive: dto.isActive, onlyWhenOnline: dto.onlyWhenOnline, nextRunAt },
        include: { tasks: { orderBy: { sequenceNumber: 'asc' } } },
      }),
    );
    await this.audit.record({ action: 'server.schedule.update', targetType: 'server', targetId: server.id, actorId: userId, metadata: { scheduleId: schedule.id } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.schedule.update', properties: { scheduleId: schedule.id } });
    return updated;
  }

  async remove(userId: string, serverId: string, scheduleId: string) {
    const { server, schedule } = await this.getOwned(userId, serverId, scheduleId, 'schedule.delete');
    await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.schedule.delete({ where: { id: schedule.id } }));
    await this.audit.record({ action: 'server.schedule.delete', targetType: 'server', targetId: server.id, actorId: userId, metadata: { scheduleId: schedule.id } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.schedule.delete', properties: { scheduleId: schedule.id } });
  }

  async addTask(userId: string, serverId: string, scheduleId: string, dto: CreateTaskDto) {
    const { server, schedule } = await this.getOwned(userId, serverId, scheduleId, 'schedule.update');
    const nextSequence = schedule.tasks.length > 0 ? Math.max(...schedule.tasks.map((t) => t.sequenceNumber)) + 1 : 1;
    const task = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.task.create({
        data: {
          scheduleId: schedule.id,
          sequenceNumber: nextSequence,
          action: dto.action,
          payload: dto.action === 'power' ? 'restart' : '',
          timeOffsetSeconds: dto.timeOffsetSeconds ?? 0,
          continueOnFailure: dto.continueOnFailure ?? false,
        },
      }),
    );
    await this.audit.record({ action: 'server.schedule.task.create', targetType: 'server', targetId: server.id, actorId: userId, metadata: { scheduleId: schedule.id, taskId: task.id, taskAction: dto.action } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.schedule.task.create', properties: { scheduleId: schedule.id, taskId: task.id, taskAction: dto.action } });
    return task;
  }

  async removeTask(userId: string, serverId: string, scheduleId: string, taskId: string) {
    const { server, schedule } = await this.getOwned(userId, serverId, scheduleId, 'schedule.update');
    const task = schedule.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundException('Task not found');
    await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.task.delete({ where: { id: task.id } }));
    await this.audit.record({ action: 'server.schedule.task.delete', targetType: 'server', targetId: server.id, actorId: userId, metadata: { scheduleId: schedule.id, taskId: task.id } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.schedule.task.delete', properties: { scheduleId: schedule.id, taskId: task.id } });
  }
}
