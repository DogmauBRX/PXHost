import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CapacityService } from '../capacity/capacity.service';
import { nodeFitReasons } from '../capacity/capacity.math';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { fitScore, rankCandidates } from './scheduler.math';

export interface SchedulerCandidate {
  nodeId: string;
  name: string;
  eliminated: boolean;
  reason?: string;
  score?: number;
}

export interface SchedulerSelection {
  selected: { nodeId: string; name: string; score: number } | null;
  candidates: SchedulerCandidate[];
}

/**
 * `selectNode` runs entirely UNLOCKED, in its own read-only transaction
 * — it is a HINT, never the authority. The actual create (`ServersService
 * .createOnNode`) re-verifies everything under the real advisory locks;
 * if the hint turns out to be stale (a concurrent create landed on the
 * chosen node between selection and the real lock), the caller excludes
 * that node and asks again. This is exactly the "escolher → travar →
 * reverificar → cair para o próximo" design the capacity plan calls for
 * — selection never becomes a second source of truth competing with the
 * lock-protected checks that already exist.
 */
@Injectable()
export class NodeSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityService,
  ) {}

  async selectNode(planId: string, opts: { excludeNodeIds?: string[]; locationId?: string } = {}): Promise<SchedulerSelection> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const plan = await tx.plan.findFirst({ where: { id: planId, deletedAt: null } });
      if (!plan) throw new NotFoundException('Plan not found');
      const request = { memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuPercent: plan.cpuLimitPercent };

      const restrictions = await tx.planNode.findMany({ where: { planId } });
      const restrictedIds = new Set(restrictions.map((r) => r.nodeId));
      const priorityById = new Map(restrictions.map((r) => [r.nodeId, r.priority]));

      const excluded = new Set(opts.excludeNodeIds ?? []);
      const nodes = await tx.node.findMany({
        where: {
          deletedAt: null,
          maintenanceMode: false,
          isPublic: true,
          ...(opts.locationId ? { locationId: opts.locationId } : {}),
        },
        orderBy: { name: 'asc' },
      });

      const candidates: SchedulerCandidate[] = [];
      const survivors: { nodeId: string; name: string; score: number; priority: number; memoryFreeMb: number }[] = [];

      for (const node of nodes) {
        if (excluded.has(node.id)) {
          candidates.push({ nodeId: node.id, name: node.name, eliminated: true, reason: 'Excluído nesta tentativa (falhou antes)' });
          continue;
        }
        if (restrictedIds.size > 0 && !restrictedIds.has(node.id)) {
          candidates.push({ nodeId: node.id, name: node.name, eliminated: true, reason: 'Plano não permitido neste node' });
          continue;
        }
        const health = deriveHealthStatus(node.lastHeartbeatAt);
        if (health === 'offline' || health === 'degraded') {
          candidates.push({ nodeId: node.id, name: node.name, eliminated: true, reason: `Node ${health}` });
          continue;
        }

        const usage = await this.capacity.usageForNode(tx, node.id);
        const reasons = nodeFitReasons(node, usage, request);
        if (reasons.length > 0) {
          candidates.push({ nodeId: node.id, name: node.name, eliminated: true, reason: reasons.join('; ') });
          continue;
        }

        const freeAllocations = await this.capacity.freeAllocationCount(tx, node.id);
        if (freeAllocations === 0) {
          candidates.push({ nodeId: node.id, name: node.name, eliminated: true, reason: 'Sem alocação livre' });
          continue;
        }

        const priority = priorityById.get(node.id) ?? 0;
        const score = fitScore(node, usage, request, priority, health === 'unknown');
        const memoryFreeMb = Math.max(node.memoryTotalMb - node.memoryReservedMb - usage.memoryMb, 0);
        candidates.push({ nodeId: node.id, name: node.name, eliminated: false, score });
        survivors.push({ nodeId: node.id, name: node.name, score, priority, memoryFreeMb });
      }

      const ranked = rankCandidates(survivors);
      const selected = ranked[0] ? { nodeId: ranked[0].nodeId, name: ranked[0].name, score: ranked[0].score } : null;
      return { selected, candidates };
    });
  }
}
