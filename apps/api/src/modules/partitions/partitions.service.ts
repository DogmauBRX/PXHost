import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface PartitionInfo {
  table: string;
  range: string | null;
}

/**
 * "Log partition automation" (architecture doc roadmap M13). audit_logs
 * and server_metrics_1m were always DOCUMENTED as RANGE-partitioned but
 * 0001_init actually created them as plain tables — a real gap this
 * milestone's own investigation found (see prisma/migrations/
 * 0004_log_partitioning and ../../README.md). This service is the thin
 * NestJS wrapper around the two SQL functions that migration added.
 *
 * ensureFuturePartitions runs on BOTH tables — a month turning over with
 * no partition ready for it is an INSERT failure in production, not a
 * cosmetic gap, so this is the actual operational problem "automation"
 * means to solve. archiveOldMetrics only touches server_metrics_1m
 * (high-volume, low-value long-term raw samples) — audit_logs
 * deliberately has NO equivalent call anywhere in this codebase: a
 * security trail should never have a code path capable of making it
 * shorter, so old audit_logs partitions just accumulate under this
 * table's REVOKE UPDATE, DELETE posture forever, exactly as intended.
 */
@Injectable()
export class PartitionsService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureFuturePartitions(monthsAhead = 3): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      // Explicit ::int cast: Prisma's $executeRaw sends a bare JS number
      // as bigint, but the SQL function's parameter is `int` — without
      // the cast, Postgres reports "function ... does not exist" (no
      // implicit bigint->int narrowing), found live the first time the
      // worker's daily job actually ran this.
      await tx.$executeRaw`SELECT ensure_future_partitions(${monthsAhead}::int)`;
    });
  }

  async archiveOldMetricPartitions(olderThanMonths = 6): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      await tx.$executeRaw`SELECT archive_old_metric_partitions(${olderThanMonths}::int)`;
    });
  }

  /** Read-only inventory for the admin UI / live verification — every partition currently attached to either parent, oldest first. */
  async list(): Promise<PartitionInfo[]> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const rows = await tx.$queryRaw<{ table: string; relname: string; range: string | null }[]>`
        SELECT parent.relname AS "table", c.relname, pg_get_expr(c.relpartbound, c.oid) AS range
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname IN ('audit_logs', 'server_metrics_1m')
        ORDER BY parent.relname, c.relname
      `;
      return rows.map((r) => ({ table: `${r.table}.${r.relname}`, range: r.range }));
    });
  }
}
