import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AgentClient } from '../nodes/agent-client.service';
import { CapabilityTokenService } from '../../core/capability-token/capability-token.service';
import { CapacityService } from '../capacity/capacity.service';
import { assertNodeFits } from '../capacity/capacity.math';
import { TransferQueueService } from './transfer-queue.service';

const ARCHIVE_TOKEN_TTL_SECONDS = 60 * 60; // 1h — generous for a large archive's fetch time, single-use regardless (jti burned on first GET)

/**
 * Live node-to-node transfer (architecture doc roadmap M13). The DB's
 * own status vocabulary (server_transfers_status_check:
 * pending|archiving|uploading|restoring|success|failed|cancelled) IS the
 * pipeline design — this service and ServerTransferProcessor just walk
 * it. initiate() does the synchronous, transactional half (capacity
 * check + allocation reservation, same pattern servers.service.ts's
 * create() already established, reused via the two exported helpers
 * below rather than re-implemented); the actual byte-moving work runs on
 * the worker (ServerTransferProcessor), off the request/response cycle,
 * because a real archive can take far longer than an HTTP client's
 * timeout should ever be set to.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly capabilityToken: CapabilityTokenService,
    private readonly queue: TransferQueueService,
    private readonly capacity: CapacityService,
  ) {}

  async initiate(serverId: string, targetNodeId: string, targetAllocationId: string | undefined, actorId: string) {
    const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.findFirst({ where: { id: serverId } }));
    if (!server) throw new NotFoundException('Server not found');
    if (server.nodeId === targetNodeId) throw new ConflictException('Server is already on that node');
    if (server.status !== 'ready') throw new ConflictException(`Server must be ready to transfer (current status: ${server.status})`);

    const { transferId } = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      // Same advisory-lock-then-capacity-check-then-pick-allocation shape
      // as ServersService.create — the target node's capacity can't be
      // double-booked by a transfer racing a fresh create, or two
      // transfers racing each other, any more than two creates can.
      await this.capacity.lockNode(tx, targetNodeId);

      const targetNode = await tx.node.findFirst({ where: { id: targetNodeId, deletedAt: null } });
      if (!targetNode) throw new NotFoundException('Target node not found');
      if (targetNode.maintenanceMode) throw new ConflictException('Target node is in maintenance mode');

      // usageForNode already includes any OTHER transfer currently in
      // flight toward this same target — this transfer's own server is
      // still on its SOURCE node at this point (nodeId only flips in
      // handleResult), so it is correctly excluded from its own check.
      const usage = await this.capacity.usageForNode(tx, targetNodeId);
      assertNodeFits(targetNode, usage, { memoryMb: server.memoryMb, diskMb: server.diskMb, cpuPercent: server.cpuLimitPercent });

      const allocation = targetAllocationId
        ? await tx.allocation.findFirst({ where: { id: BigInt(targetAllocationId), nodeId: targetNodeId, serverId: null } })
        : await this.capacity.pickFreeAllocation(tx, targetNodeId);
      if (!allocation) {
        throw new ConflictException(targetAllocationId ? 'Requested allocation is not free' : 'No free allocation available on the target node');
      }

      // The target uid is decided HERE, under the same lock, for the same
      // reason the allocation is reserved here rather than later in the
      // pipeline: runPipeline (unlocked, minutes later) bakes this exact
      // value into the container the target agent actually creates, and
      // handleResult persists it onto servers.uid only once the transfer
      // succeeds — see ServerTransfer.targetUid's doc comment.
      const targetUid = await this.capacity.nextUid(tx, targetNodeId);

      const transfer = await tx.serverTransfer.create({
        data: { serverId, sourceNodeId: server.nodeId, targetNodeId, targetAllocationId: allocation.id, targetUid, status: 'pending' },
      });
      // Reserve the target allocation NOW, under the same lock — not at
      // the end of the pipeline — for the same race-freedom reason
      // create() reserves its allocation inside the capacity-checking
      // transaction rather than after it.
      await tx.allocation.update({ where: { id: allocation.id }, data: { serverId, isPrimary: false } });
      await tx.server.update({ where: { id: serverId }, data: { status: 'transferring' } });

      return { transferId: transfer.id };
    });

    await this.audit.record({
      action: 'server.transfer.initiated',
      actorId,
      targetType: 'server',
      targetId: serverId,
      metadata: { sourceNodeId: server.nodeId, targetNodeId },
    });

    try {
      await this.queue.enqueue(transferId);
    } catch (err) {
      // The transaction above already committed (transferring + the
      // target allocation reserved) — a failure HERE (Redis briefly
      // unreachable, say) must not leave the server permanently stuck
      // in "transferring" with a job that will never run. Same
      // reasoning as ServersService.dispatchToAgent's own post-commit
      // failure handling: fail() reverts the server to ready and frees
      // the reserved allocation, so an admin can just retry.
      await this.fail(transferId, `failed to enqueue: ${(err as Error).message}`);
      throw err;
    }
    return { id: transferId, status: 'pending' };
  }

  async get(id: string) {
    const transfer = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.serverTransfer.findFirst({ where: { id } }));
    if (!transfer) throw new NotFoundException('Transfer not found');
    return transfer;
  }

  async listForServer(serverId: string) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.serverTransfer.findMany({ where: { serverId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  /**
   * The actual orchestration ServerTransferProcessor drives: stop the
   * source, export+mint a capability token+kick off the target's import,
   * and record how far the pipeline got — the pipeline's TERMINAL state
   * (success/failed) is decided by handleResult below, called back by
   * the TARGET agent once its own async import finishes, not by this
   * method (which only gets the target as far as "restoring").
   */
  async runPipeline(transferId: string): Promise<void> {
    const transfer = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.serverTransfer.findFirst({ where: { id: transferId } }));
    if (!transfer) return; // deleted/cancelled before the job ran — nothing to do

    try {
      // allocations and server_variables are RLS-protected tables (see
      // migrations/0002_rls_policies) — every read here goes through ONE
      // withRLS transaction, not the bare prisma client, or these would
      // silently come back empty under app_user's session instead of
      // erroring (the exact bug class M9's README documents finding and
      // fixing in DatabasesService).
      const { server, sourceNode, targetNode, targetAllocation, variableRows } = await this.prisma.withRLS(
        { userId: null, isAdmin: true },
        async (tx) => {
          const [server, sourceNode, targetNode, targetAllocation, variableRows] = await Promise.all([
            tx.server.findFirstOrThrow({ where: { id: transfer.serverId }, include: { template: true } }),
            tx.node.findFirstOrThrow({ where: { id: transfer.sourceNodeId } }),
            tx.node.findFirstOrThrow({ where: { id: transfer.targetNodeId } }),
            transfer.targetAllocationId ? tx.allocation.findFirstOrThrow({ where: { id: transfer.targetAllocationId } }) : Promise.resolve(null),
            tx.serverVariable.findMany({ where: { serverId: transfer.serverId }, include: { variable: true } }),
          ]);
          return { server, sourceNode, targetNode, targetAllocation, variableRows };
        },
      );
      if (!targetAllocation) throw new Error('transfer has no target allocation');

      await this.setStatus(transferId, 'archiving', { startedAt: new Date() });
      await this.agent.power(transfer.sourceNodeId, transfer.serverId, 'stop').catch(() => undefined); // best-effort: already offline is fine, export itself enforces stopped
      const archive = await this.agent.exportTransfer(transfer.sourceNodeId, transfer.serverId);

      await this.setStatus(transferId, 'uploading');
      const token = this.capabilityToken.mint({
        serverUuid: transfer.serverId,
        nodeUuid: transfer.sourceNodeId,
        userId: 'system:transfer',
        cap: 'transfer.download',
        permissions: [],
        ttlSeconds: ARCHIVE_TOKEN_TTL_SECONDS,
        ctx: { path: archive.id },
      });
      const sourceUrl = this.agent.transferDownloadUrl(sourceNode.scheme, sourceNode.fqdn, sourceNode.daemonPort, transfer.serverId, archive.id);

      // Decided once, under the target node's advisory lock, back in
      // initiate() — never re-derived here for a transfer created after
      // this change. The fallback below only matters for a transfer row
      // that was already "pending" in the queue at deploy time (created
      // before `targetUid` existed) — vanishingly rare, but re-deriving
      // unconditionally would risk computing a DIFFERENT uid than
      // whatever handleResult later persists onto servers.uid once this
      // container already exists under the value baked in below.
      let targetUid = transfer.targetUid;
      if (targetUid == null) {
        const computedUid = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          this.capacity.lockNode(tx, transfer.targetNodeId).then(() => this.capacity.nextUid(tx, transfer.targetNodeId)),
        );
        // Persisted immediately — handleResult reads transfer.targetUid
        // fresh from the DB, not this in-memory value, so without this
        // write it would see NULL again and lose the uid this container
        // was actually created with.
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.serverTransfer.update({ where: { id: transferId }, data: { targetUid: computedUid } }));
        targetUid = computedUid;
      }
      // Narrowed to a concrete number above; a fresh const avoids relying
      // on control-flow narrowing of `targetUid` across the awaits above.
      const resolvedUid: number = targetUid;

      await this.agent.importTransfer(transfer.targetNodeId, {
        uuid: transfer.serverId,
        uid: resolvedUid,
        image: server.dockerImage,
        startupTemplate: server.startupCommand,
        declaredVariables: variableRows.map((v) => v.variable.envVariable),
        variables: Object.fromEntries(variableRows.map((v) => [v.variable.envVariable, v.value])),
        limits: {
          cpuPercent: server.cpuLimitPercent,
          memoryMb: server.memoryMb,
          swapMb: server.swapMb,
          diskMb: server.diskMb,
          ioWeight: server.ioWeight,
        },
        allocations: [{ ip: targetAllocation.ip, port: targetAllocation.port, primary: true }],
        installImage: '',
        installEntrypoint: '',
        installScript: '',
        transferId,
        archiveId: archive.id,
        sourceUrl,
        sourceToken: token,
      });
      await this.setStatus(transferId, 'restoring');
    } catch (err) {
      await this.fail(transferId, (err as Error).message);
    }
  }

  /** Called by the TARGET agent (NodeAuthGuard) once its async import finishes. */
  async handleResult(nodeId: string, transferId: string, successful: boolean, errorMessage?: string): Promise<void> {
    const transfer = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.serverTransfer.findFirst({ where: { id: transferId } }));
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.targetNodeId !== nodeId) throw new NotFoundException('Transfer not found on this node');

    if (successful) {
      await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
        await tx.allocation.updateMany({ where: { serverId: transfer.serverId, nodeId: transfer.sourceNodeId }, data: { serverId: null, isPrimary: false } });
        if (transfer.targetAllocationId) {
          await tx.allocation.update({ where: { id: transfer.targetAllocationId }, data: { isPrimary: true } });
        }
        // uid flips here, alongside nodeId — the persisted value must
        // always match what the container on the NEW node was actually
        // created with, and stays whatever it was on the old node until
        // this exact moment the move is confirmed.
        await tx.server.update({ where: { id: transfer.serverId }, data: { nodeId: transfer.targetNodeId, uid: transfer.targetUid, status: 'ready' } });
        await tx.serverTransfer.update({ where: { id: transferId }, data: { status: 'success', completedAt: new Date() } });
      });
      await this.audit.record({ action: 'server.transfer.succeeded', targetType: 'server', targetId: transfer.serverId, metadata: { sourceNodeId: transfer.sourceNodeId, targetNodeId: transfer.targetNodeId } });

      // Best-effort teardown of the now-superseded source copy — the
      // transfer already succeeded from the customer's point of view;
      // a source node that's unreachable at THIS moment just leaves an
      // orphaned container/archive behind for an operator to notice,
      // it does not undo the (already-committed) move.
      await this.agent.deleteServer(transfer.sourceNodeId, transfer.serverId).catch(() => undefined);
    } else {
      await this.fail(transferId, errorMessage ?? 'target node reported failure', transfer.serverId);
    }
  }

  private async fail(transferId: string, errorMessage: string, serverId?: string): Promise<void> {
    const transfer = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const row = await tx.serverTransfer.update({ where: { id: transferId }, data: { status: 'failed', errorMessage, completedAt: new Date() } });
      // The allocation reserved on the target at initiate() time is
      // freed — a failed transfer must not permanently squat a port.
      if (row.targetAllocationId) {
        await tx.allocation.update({ where: { id: row.targetAllocationId }, data: { serverId: null, isPrimary: false } });
      }
      await tx.server.update({ where: { id: row.serverId }, data: { status: 'ready' } });
      return row;
    });
    await this.audit.record({ action: 'server.transfer.failed', targetType: 'server', targetId: serverId ?? transfer.serverId, metadata: { errorMessage } });
  }

  private async setStatus(transferId: string, status: string, extra?: Record<string, unknown>): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.serverTransfer.update({ where: { id: transferId }, data: { status, ...extra } }));
  }
}
