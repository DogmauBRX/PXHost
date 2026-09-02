import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateNodeDto, UpdateNodeDto } from './dto/node.dto';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

const ONLINE_THRESHOLD_MS = 45_000;
const DEGRADED_THRESHOLD_MS = 120_000;

/**
 * Derives node health from last_heartbeat_at at READ time rather than
 * relying solely on the stored `health_status` column staying fresh.
 * Architecture doc 3.5 defines online (<45s) / degraded (45-120s) /
 * offline (>120s); a background sweep job that flips stale nodes to
 * "offline" in the database is a later-milestone concern (it matters for
 * things like excluding a node from auto-deploy), but every READ already
 * reflects true freshness regardless of whether that sweep has run yet.
 */
export function deriveHealthStatus(lastHeartbeatAt: Date | null): string {
  if (!lastHeartbeatAt) return 'unknown';
  const age = Date.now() - lastHeartbeatAt.getTime();
  if (age < ONLINE_THRESHOLD_MS) return 'online';
  if (age < DEGRADED_THRESHOLD_MS) return 'degraded';
  return 'offline';
}

export type DivergenceStatus = 'ok' | 'over' | 'unknown';

/**
 * Capacity plan Fase 7: compares DECLARED commercial capacity against
 * what the agent actually REPORTED, computed at read time and never
 * stored — same posture as `deriveHealthStatus` just above. Deliberately
 * asymmetric: `'over'` only when declared > reported (selling more than
 * the machine actually has), never the reverse. Declaring less than the
 * physical total is the NORMAL, correct case here — the agent runs
 * directly on the Proxmox host (Fase 0 topology decision), so reported
 * memory/disk includes whatever Proxmox and the node's other VMs are
 * using, and a sane admin's declared total is always somewhat below
 * that. `'unknown'` (never a false "ok") whenever there's no telemetry
 * to compare against at all — an agent older than this milestone, or one
 * that hasn't heartbeated since.
 */
export function deriveTelemetryDivergence(node: {
  memoryTotalMb: number;
  reportedMemoryTotalMb: number | null;
  diskTotalMb: number;
  reportedDiskTotalMb: number | null;
  cpuTotalPercent: number;
  reportedCpuCount: number | null;
}): { memory: DivergenceStatus; disk: DivergenceStatus; cpu: DivergenceStatus } {
  const memory: DivergenceStatus =
    node.reportedMemoryTotalMb == null ? 'unknown' : node.memoryTotalMb > node.reportedMemoryTotalMb ? 'over' : 'ok';
  const disk: DivergenceStatus =
    node.reportedDiskTotalMb == null ? 'unknown' : node.diskTotalMb > node.reportedDiskTotalMb ? 'over' : 'ok';
  // cpuTotalPercent is "percent of a core" (100 = 1 core); reportedCpuCount
  // is a whole core count — same unit conversion `vCPU = cpuLimitPercent /
  // 100` already uses elsewhere (capacity plan Fase 2). cpuTotalPercent
  // <= 0 means CPU accounting is off for this node (its own established
  // meaning, see nodes_cpu_accounting_check) — nothing declared to compare.
  const cpu: DivergenceStatus =
    node.cpuTotalPercent <= 0 || node.reportedCpuCount == null ? 'unknown' : node.cpuTotalPercent / 100 > node.reportedCpuCount ? 'over' : 'ok';
  return { memory, disk, cpu };
}

// Every query in this service that can return a full node row omits
// controlTokenEnc explicitly (Prisma 6's `omit`) — it is never legitimate
// for this ciphertext to reach an HTTP response, and relying on every
// call site to remember a `select` allowlist is exactly the kind of thing
// that gets forgotten once. The bootstrap/AgentClient code paths that
// actually need it query the field directly with their own narrow
// `select`, never through this service.
const OMIT_CONTROL_TOKEN = { controlTokenEnc: true } as const;

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const nodes = await this.prisma.node.findMany({
      where: { deletedAt: null },
      include: { location: true, _count: { select: { servers: true, allocations: true } } },
      omit: OMIT_CONTROL_TOKEN,
      orderBy: { name: 'asc' },
    });
    return nodes.map((n) => ({ ...n, healthStatus: deriveHealthStatus(n.lastHeartbeatAt), telemetryDivergence: deriveTelemetryDivergence(n) }));
  }

  async get(id: string) {
    const node = await this.prisma.node.findFirst({
      where: { id, deletedAt: null },
      include: { location: true, _count: { select: { servers: true, allocations: true } } },
      omit: OMIT_CONTROL_TOKEN,
    });
    if (!node) throw new NotFoundException('Node not found');
    return { ...node, healthStatus: deriveHealthStatus(node.lastHeartbeatAt), telemetryDivergence: deriveTelemetryDivergence(node) };
  }

  async create(dto: CreateNodeDto, actor: AuthenticatedUser) {
    const location = await this.prisma.location.findFirst({ where: { id: dto.locationId, deletedAt: null } });
    if (!location) throw new NotFoundException('Location not found');

    let created;
    try {
      created = await this.prisma.node.create({
        data: {
          locationId: dto.locationId,
          name: dto.name,
          description: dto.description,
          fqdn: dto.fqdn,
          scheme: dto.scheme ?? 'https',
          daemonPort: dto.daemonPort ?? 8443,
          sftpPort: dto.sftpPort ?? 2022,
          memoryTotalMb: dto.memoryTotalMb,
          memoryReservedMb: dto.memoryReservedMb ?? 0,
          memoryOverallocatePct: dto.memoryOverallocatePct ?? 0,
          diskTotalMb: dto.diskTotalMb,
          diskReservedMb: dto.diskReservedMb ?? 0,
          diskOverallocatePct: dto.diskOverallocatePct ?? 0,
          cpuTotalPercent: dto.cpuTotalPercent ?? 0,
          cpuReservedPercent: dto.cpuReservedPercent ?? 0,
          cpuOverallocatePct: dto.cpuOverallocatePct ?? -1,
          isPublic: dto.isPublic ?? true,
          uploadSizeMb: dto.uploadSizeMb ?? 256,
        },
        omit: OMIT_CONTROL_TOKEN,
      });
    } catch (err) {
      if (isCapacityCheckViolation(err)) {
        throw new BadRequestException(
          'Invalid capacity values: reserved must not exceed total, and CPU overallocate cannot be set to a real percentage while cpuTotalPercent is 0',
        );
      }
      throw err;
    }

    await this.audit.record({
      action: 'admin.node.create',
      actorId: actor.id,
      targetType: 'node',
      targetId: created.id,
      metadata: {
        name: created.name,
        locationId: created.locationId,
        memoryTotalMb: created.memoryTotalMb,
        diskTotalMb: created.diskTotalMb,
        cpuTotalPercent: created.cpuTotalPercent,
      },
    });
    return created;
  }

  /**
   * Explicit field map (capacity plan Fase 2) rather than `data: dto`
   * spread — today's DTO happens to line up 1:1 with updatable columns,
   * but a raw spread is the one place a future DTO field (or a field
   * added to the DTO for a different endpoint that reuses it) reaches
   * the database with no validation this service controls. Also the
   * natural place to audit every field this update can actually touch,
   * including the commercial-capacity ones the capacity plan explicitly
   * requires auditing (reserve/overallocate/total changes).
   */
  async update(id: string, dto: UpdateNodeDto, actor: AuthenticatedUser) {
    const before = await this.get(id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isPublic !== undefined) data.isPublic = dto.isPublic;
    if (dto.maintenanceMode !== undefined) data.maintenanceMode = dto.maintenanceMode;
    if (dto.memoryTotalMb !== undefined) data.memoryTotalMb = dto.memoryTotalMb;
    if (dto.memoryReservedMb !== undefined) data.memoryReservedMb = dto.memoryReservedMb;
    if (dto.memoryOverallocatePct !== undefined) data.memoryOverallocatePct = dto.memoryOverallocatePct;
    if (dto.diskTotalMb !== undefined) data.diskTotalMb = dto.diskTotalMb;
    if (dto.diskReservedMb !== undefined) data.diskReservedMb = dto.diskReservedMb;
    if (dto.diskOverallocatePct !== undefined) data.diskOverallocatePct = dto.diskOverallocatePct;
    if (dto.cpuTotalPercent !== undefined) data.cpuTotalPercent = dto.cpuTotalPercent;
    if (dto.cpuReservedPercent !== undefined) data.cpuReservedPercent = dto.cpuReservedPercent;
    if (dto.cpuOverallocatePct !== undefined) data.cpuOverallocatePct = dto.cpuOverallocatePct;

    let updated;
    try {
      updated = await this.prisma.node.update({ where: { id }, data, omit: OMIT_CONTROL_TOKEN });
    } catch (err) {
      // The capacity CHECK constraints added in migration 0010 (reserved
      // <= total, CPU overallocate without a CPU total, etc.) are the
      // last line of defense — the DTO's own `@Min` decorators catch the
      // obvious cases, but "reserved > total" and "CPU overallocate set
      // with total still 0" both pass DTO validation individually and
      // only become invalid in combination with the row's OTHER current
      // values (a PATCH that only touches one field). Translated to 400
      // rather than left to bubble up as an unhandled 500, mirroring
      // billing-webhook.service.ts's identical P2002 guard for the same
      // reason: a database-level rejection is still a validation error
      // from the caller's point of view.
      if (isCapacityCheckViolation(err)) {
        throw new BadRequestException(
          'Invalid capacity values: reserved must not exceed total, and CPU overallocate cannot be set to a real percentage while cpuTotalPercent is 0',
        );
      }
      throw err;
    }

    if (Object.keys(data).length > 0) {
      await this.audit.record({
        action: 'admin.node.update',
        actorId: actor.id,
        targetType: 'node',
        targetId: id,
        beforeState: Object.fromEntries(Object.keys(data).map((k) => [k, (before as Record<string, unknown>)[k]])),
        afterState: data,
      });
    }
    return { ...updated, healthStatus: deriveHealthStatus(updated.lastHeartbeatAt), telemetryDivergence: deriveTelemetryDivergence(updated) };
  }

  async remove(id: string, actor: AuthenticatedUser) {
    await this.get(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { nodeId: id } }));
    if (serverCount > 0) throw new ConflictException('Node has servers; transfer or delete them first');
    await this.prisma.node.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({ action: 'admin.node.delete', actorId: actor.id, targetType: 'node', targetId: id });
  }
}

/**
 * Detects a CHECK-constraint violation from the capacity constraints
 * added in migration 0010 (`nodes_cpu_accounting_check`,
 * `nodes_memory_reserved_check`, etc). Matching `code === 'P2004'` alone
 * is NOT enough — verified live against Prisma 6.19.3/Postgres 16, a
 * plain `.update()` hitting one of these CHECKs actually surfaces as
 * `PrismaClientUnknownRequestError` (no `.code` at all), wrapping the
 * raw Postgres `SQLSTATE 23514` in its `.message`, not as the "known"
 * P2004 error billing-webhook.service.ts's P2002 guard could pattern
 * itself after. Matching on the message is therefore the reliable path
 * across both shapes Prisma might throw for the same underlying error.
 */
function isCapacityCheckViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: string }).code === 'P2004') return true;
  const message = (err as { message?: string }).message ?? '';
  return message.includes('23514') || message.includes('violates check constraint');
}
