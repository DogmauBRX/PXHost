import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface ActivityEvent {
  actorId: string;
  serverId: string;
  event: string;
  properties?: Record<string, unknown>;
}

/**
 * The customer-facing activity feed (architecture doc 2.1: "activity_logs
 * is separate from audit_logs — the former is an append-only security
 * trail [staff-facing], the latter is the customer-facing feed"). Every
 * mutation across files/backups/databases/schedules/power/subusers writes
 * here, alongside — not instead of — its own AuditService.record() call
 * where one already exists; they serve different readers.
 *
 * Written under withRLS with the ACTOR's own context so the table's own
 * WITH CHECK (actor_id = current_app_user()) enforces "attributed" at the
 * database level, not just by convention in application code — a write
 * that claimed a different actor_id is rejected by Postgres itself.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: ActivityEvent): Promise<void> {
    await this.prisma.withRLS({ userId: event.actorId, isAdmin: false }, (tx) =>
      tx.activityLog.create({
        data: {
          actorId: event.actorId,
          serverId: event.serverId,
          event: event.event,
          properties: (event.properties ?? {}) as object,
        },
      }),
    );
  }

  async list(userId: string, serverId: string, isAdmin = false, limit = 50) {
    return this.prisma.withRLS({ userId, isAdmin }, (tx) =>
      tx.activityLog.findMany({
        where: { serverId },
        take: Math.min(limit, 200),
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, username: true, email: true } } },
      }),
    );
  }
}
