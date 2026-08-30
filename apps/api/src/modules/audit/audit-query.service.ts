import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/**
 * The read side of the audit trail, kept deliberately separate from
 * `AuditService` — that one writes, and its append-only contract (the DB
 * REVOKEs UPDATE/DELETE and enforces immutability with triggers, see
 * migration 0002) is easier to reason about when nothing in the same class
 * can read back and tempt a "fix up that row" method into existence.
 *
 * `audit_logs` has no RLS policy, so no `withRLS` wrapper is needed here —
 * this is a global admin catalog, and the controller's AdminGuard is the
 * access control.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogsDto) {
    const take = query.limit ?? 50;
    const skip = query.offset ?? 0;

    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          occurredAt: true,
          action: true,
          actorEmail: true,
          actorIp: true,
          targetType: true,
          targetId: true,
          metadata: true,
          actor: { select: { id: true, username: true, email: true } },
          // beforeState / afterState are deliberately NOT selected: they are
          // unbounded JSON snapshots of arbitrary records and can contain
          // values that have no business in a list payload. A dedicated
          // detail endpoint is the place for them, if one is ever wanted.
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    // `id` is BigInt; the global toJSON polyfill (core/bigint-json.polyfill)
    // already renders it as a string on the wire.
    return { items: rows, total, limit: take, offset: skip };
  }
}
