import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface AuditEvent {
  actorId?: string | null;
  actorEmail?: string | null;
  actorIp?: string | null;
  action: string; // dotted, e.g. "auth.login.success"
  targetType?: string;
  targetId?: string;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only security/compliance trail (architecture doc 3.6). Auth
 * events are written synchronously in the request path — security-critical
 * events must never be lost to a crashed background queue, per the
 * architecture's explicit call-out that these are the ones written inline
 * rather than via BullMQ (that queue lands in a later milestone).
 *
 * The `audit_logs` table itself is append-only at the database level
 * (REVOKE UPDATE, DELETE from the app role — see the RLS/grants
 * migration); this service never attempts to update or delete a row.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: event.actorId ?? null,
          actorEmail: event.actorEmail ?? null,
          actorIp: event.actorIp ?? null,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          beforeState: (event.beforeState as any) ?? undefined,
          afterState: (event.afterState as any) ?? undefined,
          metadata: (event.metadata as any) ?? {},
        },
      });
    } catch (err) {
      // Audit writes must never take down the request that triggered
      // them, but a failure here is itself worth knowing about loudly.
      this.logger.error(`failed to write audit log for action=${event.action}`, err as Error);
    }
  }
}
