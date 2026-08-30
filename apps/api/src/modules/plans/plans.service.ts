import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

// The plan fields snapshotted onto every server at creation time
// (architecture doc 2.1: "Snapshot, not reference ... editing a plan
// never silently resizes running containers") — the exact set
// applyToServers compares and can push. maxAllocations isn't here: it's
// checked only at allocation-request time, never snapshotted onto the
// server row itself, so there's nothing on a server to drift from it.
const DRIFTABLE_FIELDS = ['cpuLimitPercent', 'memoryMb', 'swapMb', 'diskMb', 'ioWeight', 'oomKillEnabled', 'maxDatabases', 'maxBackups', 'maxSchedules'] as const;
type DriftableField = (typeof DRIFTABLE_FIELDS)[number];

// Of those, only these five actually reach the agent — the rest
// (oomKillEnabled: hardcoded false agent-side regardless, architecture
// doc 4.6; maxDatabases/maxBackups/maxSchedules: pure panel-side quota
// checks) have no live container state to push.
const LIVE_RESOURCE_FIELDS: DriftableField[] = ['cpuLimitPercent', 'memoryMb', 'swapMb', 'diskMb', 'ioWeight'];

export interface PlanDriftEntry {
  serverId: string;
  serverName: string;
  nodeId: string;
  changes: { field: DriftableField; from: number | boolean; to: number | boolean }[];
}

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.plan.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  }

  async get(id: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id, deletedAt: null } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async create(dto: CreatePlanDto) {
    const existing = await this.prisma.plan.findFirst({ where: { slug: dto.slug, deletedAt: null } });
    if (existing) throw new ConflictException('slug already in use');
    return this.prisma.plan.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        cpuLimitPercent: dto.cpuLimitPercent ?? 100,
        memoryMb: dto.memoryMb,
        swapMb: dto.swapMb ?? 0,
        diskMb: dto.diskMb,
        ioWeight: dto.ioWeight ?? 500,
        oomKillEnabled: dto.oomKillEnabled ?? false,
        maxDatabases: dto.maxDatabases ?? 0,
        maxBackups: dto.maxBackups ?? 0,
        maxAllocations: dto.maxAllocations ?? 1,
        maxSchedules: dto.maxSchedules ?? 5,
        isPublic: dto.isPublic ?? true,
      },
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.get(id);
    // Deliberately just the DB row — a plan edit alone never touches a
    // single running server (architecture doc 2.1). applyToServers is
    // the separate, explicit, audited action that does.
    return this.prisma.plan.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { planId: id } }));
    if (serverCount > 0) throw new ConflictException('Plan is in use by existing servers');
    await this.prisma.plan.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /**
   * The dry run half of "apply to N servers" (architecture doc 2.1/9):
   * every server still assigned this plan, diffed field-by-field against
   * the plan's CURRENT values. Read-only — computing this never touches
   * a server or the agent.
   */
  async drift(planId: string): Promise<{ plan: { id: string; name: string }; affectedCount: number; servers: PlanDriftEntry[] }> {
    const plan = await this.get(planId);
    const servers = await this.computeDrift(plan);
    return { plan: { id: plan.id, name: plan.name }, affectedCount: servers.length, servers };
  }

  private async computeDrift(plan: Awaited<ReturnType<PlansService['get']>>): Promise<PlanDriftEntry[]> {
    const servers = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findMany({ where: { planId: plan.id }, select: { id: true, name: true, nodeId: true, ...Object.fromEntries(DRIFTABLE_FIELDS.map((f) => [f, true])) } }),
    );

    const entries: PlanDriftEntry[] = [];
    for (const server of servers) {
      const changes = diffFields(server as unknown as Record<DriftableField, number | boolean>, plan as unknown as Record<DriftableField, number | boolean>);
      if (changes.length > 0) {
        entries.push({ serverId: server.id, serverName: server.name, nodeId: server.nodeId, changes });
      }
    }
    return entries;
  }

  /**
   * Actually applies the plan's current values to every drifted server:
   * updates each server row's snapshot (so future reads/drift-checks see
   * the new baseline) and, best-effort, pushes the resource-affecting
   * subset live via AgentClient.updateLimits — one unreachable node must
   * never block the rest of the batch, but every failure is returned so
   * the admin sees exactly which servers still need a manual follow-up
   * (matches the resilience posture already established for backup/
   * database teardown in M8/M9).
   */
  async applyToServers(planId: string, actorId: string): Promise<{ appliedCount: number; failures: { serverId: string; error: string }[] }> {
    const plan = await this.get(planId);
    const servers = await this.computeDrift(plan);
    const failures: { serverId: string; error: string }[] = [];
    let appliedCount = 0;

    for (const entry of servers) {
      const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.findFirst({ where: { id: entry.serverId } }));
      if (!server) continue; // deleted between drift() and here

      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.server.update({
          where: { id: server.id },
          data: {
            cpuLimitPercent: plan.cpuLimitPercent,
            memoryMb: plan.memoryMb,
            swapMb: plan.swapMb,
            diskMb: plan.diskMb,
            ioWeight: plan.ioWeight,
            oomKillEnabled: plan.oomKillEnabled,
            maxDatabases: plan.maxDatabases,
            maxBackups: plan.maxBackups,
            maxSchedules: plan.maxSchedules,
          },
        }),
      );

      const touchesLiveResources = entry.changes.some((c) => LIVE_RESOURCE_FIELDS.includes(c.field));
      if (touchesLiveResources) {
        try {
          await this.agent.updateLimits(entry.nodeId, entry.serverId, {
            cpuPercent: plan.cpuLimitPercent,
            memoryMb: plan.memoryMb,
            swapMb: plan.swapMb,
            diskMb: plan.diskMb,
            ioWeight: plan.ioWeight,
          });
        } catch (err) {
          failures.push({ serverId: entry.serverId, error: (err as Error).message });
          continue;
        }
      }
      appliedCount++;
    }

    await this.audit.record({
      action: 'plan.apply',
      targetType: 'plan',
      targetId: planId,
      actorId,
      metadata: { affectedCount: servers.length, appliedCount, failureCount: failures.length },
    });

    return { appliedCount, failures };
  }
}

function diffFields(server: Record<DriftableField, number | boolean>, plan: Record<DriftableField, number | boolean>): { field: DriftableField; from: number | boolean; to: number | boolean }[] {
  const changes: { field: DriftableField; from: number | boolean; to: number | boolean }[] = [];
  for (const field of DRIFTABLE_FIELDS) {
    if (server[field] !== plan[field]) {
      changes.push({ field, from: server[field], to: plan[field] });
    }
  }
  return changes;
}
