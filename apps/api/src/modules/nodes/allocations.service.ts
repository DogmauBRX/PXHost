import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CreateAllocationRangeDto } from './dto/node.dto';

const MAX_RANGE_SIZE = 1000; // architecture doc 3.2: reject >1000 ports created at once

/**
 * `allocations` is one of the RLS-enabled tables (migration
 * 0002_rls_policies): `USING (current_app_is_admin() OR (server_id IS NOT
 * NULL AND can_access_server(server_id)))`. Every method here therefore
 * runs through `withRLS({ isAdmin: true }, ...)` — this is not optional
 * decoration, it's the difference between working and a hard 500.
 *
 * This was caught the hard way: the first version of this service called
 * the plain (RLS-restricted, no context set) connection directly, and
 * `createRange` failed outright with "new row violates row-level security
 * policy for table allocations" the moment the live e2e suite exercised
 * it — a freshly-created allocation has `server_id IS NULL`, so with no
 * admin context the policy's `USING` clause (which Postgres also applies
 * to inserts absent an explicit `WITH CHECK`) evaluates to false
 * unconditionally. Every route in NodesController that reaches this
 * service is already `AdminGuard`-gated, so `isAdmin: true` is exactly
 * the right context, not a workaround — but it must be applied here, not
 * assumed from the controller layer.
 */
@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService) {}

  private asAdmin<T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  async listForNode(nodeId: string) {
    await this.assertNodeExists(nodeId);
    // Also needs admin context to READ: the policy's USING clause hides
    // unassigned (server_id IS NULL) allocations from anyone without it,
    // and an admin managing a node's allocation pool must see those —
    // they're the whole point of this endpoint.
    return this.asAdmin((tx) => tx.allocation.findMany({ where: { nodeId }, orderBy: [{ ip: 'asc' }, { port: 'asc' }] }));
  }

  async createRange(nodeId: string, dto: CreateAllocationRangeDto) {
    await this.assertNodeExists(nodeId);
    if (dto.endPort < dto.startPort) {
      throw new ConflictException('endPort must be >= startPort');
    }
    const size = dto.endPort - dto.startPort + 1;
    if (size > MAX_RANGE_SIZE) {
      throw new ConflictException(`Range too large: ${size} ports (max ${MAX_RANGE_SIZE} per request)`);
    }

    return this.asAdmin(async (tx) => {
      const existing = await tx.allocation.findMany({
        where: { nodeId, ip: dto.ip, port: { gte: dto.startPort, lte: dto.endPort } },
        select: { port: true },
      });
      const existingPorts = new Set(existing.map((a) => a.port));

      const toCreate = [];
      for (let port = dto.startPort; port <= dto.endPort; port++) {
        if (!existingPorts.has(port)) {
          toCreate.push({ nodeId, ip: dto.ip, ipAlias: dto.ipAlias, port });
        }
      }

      if (toCreate.length > 0) {
        await tx.allocation.createMany({ data: toCreate });
      }
      return { created: toCreate.length, skippedExisting: existingPorts.size };
    });
  }

  async remove(nodeId: string, allocationId: bigint): Promise<void> {
    await this.asAdmin(async (tx) => {
      const alloc = await tx.allocation.findFirst({ where: { id: allocationId, nodeId } });
      if (!alloc) throw new NotFoundException('Allocation not found');
      if (alloc.serverId) throw new ConflictException('Allocation is in use by a server');
      await tx.allocation.delete({ where: { id: allocationId } });
    });
  }

  private async assertNodeExists(nodeId: string): Promise<void> {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null }, select: { id: true } });
    if (!node) throw new NotFoundException('Node not found');
  }
}
