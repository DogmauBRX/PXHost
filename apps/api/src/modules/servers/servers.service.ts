import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient, CreateAgentServerRequest } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { DatabasesService } from '../databases/databases.service';
import { ActivityService } from '../activity/activity.service';
import { CreateServerDto } from './dto/server.dto';
import { generateShortId } from './short-id';

const DEFAULT_INSTALL_IMAGE = 'ghcr.io/pxhost/installers:debian';
const DEFAULT_INSTALL_ENTRYPOINT = 'bash';
const UID_BASE = 100000;

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly databases: DatabasesService,
    private readonly activity: ActivityService,
  ) {}

  async list(ownerId?: string) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findMany({
        where: ownerId ? { ownerId } : undefined,
        include: {
          node: { select: { id: true, name: true, fqdn: true } },
          template: true,
          plan: true,
          owner: { select: { id: true, username: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async get(id: string) {
    const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findFirst({
        where: { id },
        include: {
          node: { select: { id: true, name: true, fqdn: true } },
          template: true,
          plan: true,
          allocations: true,
          variables: { include: { variable: true } },
          owner: { select: { id: true, username: true, email: true } },
        },
      }),
    );
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  /**
   * The M5 create transaction (architecture doc 2.6/4.4/roadmap M5):
   * capacity check + allocation reservation + limit snapshot, all under
   * one advisory lock on the node so two concurrent creates can never
   * both pass the same capacity check — proven by
   * servers.concurrency.spec.ts's race test, not just asserted here.
   *
   * The Docker-side work (pull, create, install) happens AFTER this
   * transaction commits, via AgentClient — a slow or unreachable agent
   * must never hold the node's capacity lock.
   */
  async create(dto: CreateServerDto): Promise<{ id: string; shortId: string; status: string }> {
    const owner = await this.prisma.user.findFirst({ where: { id: dto.ownerId, deletedAt: null } });
    if (!owner) throw new NotFoundException('Owner not found');

    const template = await this.prisma.serverTemplate.findFirst({ where: { id: dto.templateId, deletedAt: null } });
    if (!template) throw new NotFoundException('Template not found');

    const plan = await this.prisma.plan.findFirst({ where: { id: dto.planId, deletedAt: null } });
    if (!plan) throw new NotFoundException('Plan not found');

    const images = template.dockerImages as Record<string, string>;
    const [, dockerImage] = Object.entries(images)[0] ?? [undefined, undefined];
    if (!dockerImage) throw new ConflictException('Template has no docker images configured');

    const created = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      // Every capacity check + allocation pick for this node is
      // serialized by this lock for the duration of the transaction —
      // this is what makes two concurrent creates unable to both read
      // "capacity available" before either has committed its own usage.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('node:' || ${dto.nodeId}))`;

      const node = await tx.node.findFirst({ where: { id: dto.nodeId, deletedAt: null } });
      if (!node) throw new NotFoundException('Node not found');
      if (node.maintenanceMode) throw new ConflictException('Node is in maintenance mode');

      const usage = await tx.server.aggregate({
        where: { nodeId: dto.nodeId, status: { not: 'deleting' } },
        _sum: { memoryMb: true, diskMb: true },
      });
      const usedMemory = usage._sum.memoryMb ?? 0;
      const usedDisk = usage._sum.diskMb ?? 0;

      assertCapacity('memory', usedMemory, plan.memoryMb, node.memoryTotalMb, node.memoryReservedMb, node.memoryOverallocatePct);
      assertCapacity('disk', usedDisk, plan.diskMb, node.diskTotalMb, node.diskReservedMb, node.diskOverallocatePct);
      // CPU is deliberately NOT capacity-checked when cpuOverallocatePct
      // is -1 (the default) — CPU is time-shared; architecture doc 2.6
      // is explicit that blocking sales on the nominal sum wastes
      // hardware. A node opted into strict CPU accounting would need
      // the same assertCapacity call here; out of scope for M5.

      const allocation = dto.allocationId
        ? await tx.allocation.findFirst({ where: { id: BigInt(dto.allocationId), nodeId: dto.nodeId, serverId: null } })
        : await pickFreeAllocation(tx, dto.nodeId);
      if (!allocation) {
        throw new ConflictException(
          dto.allocationId ? 'Requested allocation is not free' : 'No free allocation available on this node',
        );
      }

      const uid = UID_BASE + (await tx.server.count({ where: { nodeId: dto.nodeId } }));
      const shortId = await generateUniqueShortId(tx);

      const server = await tx.server.create({
        data: {
          shortId,
          ownerId: dto.ownerId,
          nodeId: dto.nodeId,
          templateId: dto.templateId,
          planId: dto.planId,
          name: dto.name,
          dockerImage,
          startupCommand: template.startupCommand,
          cpuLimitPercent: plan.cpuLimitPercent,
          memoryMb: plan.memoryMb,
          swapMb: plan.swapMb,
          diskMb: plan.diskMb,
          ioWeight: plan.ioWeight,
          oomKillEnabled: plan.oomKillEnabled,
          maxDatabases: plan.maxDatabases,
          maxBackups: plan.maxBackups,
          maxAllocations: plan.maxAllocations,
          maxSchedules: plan.maxSchedules,
          status: 'installing',
        },
      });

      await tx.allocation.update({ where: { id: allocation.id }, data: { serverId: server.id, isPrimary: true } });

      const templateVars = await tx.templateVariable.findMany({ where: { templateId: dto.templateId } });
      const declaredNames = templateVars.map((v) => v.envVariable);
      const requested = dto.variables ?? {};
      const resolvedValues: Record<string, string> = {};
      for (const tv of templateVars) {
        const value = requested[tv.envVariable] ?? tv.defaultValue;
        resolvedValues[tv.envVariable] = value;
        await tx.serverVariable.create({ data: { serverId: server.id, variableId: tv.id, value } });
      }

      return { server, uid, allocation, declaredNames, resolvedValues };
    });

    await this.audit.record({
      action: 'server.create',
      targetType: 'server',
      targetId: created.server.id,
      metadata: { ownerId: dto.ownerId, nodeId: dto.nodeId, templateId: dto.templateId, planId: dto.planId },
    });

    await this.dispatchToAgent(created.server.id, dto.nodeId, {
      uuid: created.server.id,
      uid: created.uid,
      image: dockerImage,
      startupTemplate: template.startupCommand,
      stopSignal: undefined,
      declaredVariables: created.declaredNames,
      variables: created.resolvedValues,
      limits: {
        cpuPercent: plan.cpuLimitPercent,
        memoryMb: plan.memoryMb,
        swapMb: plan.swapMb,
        diskMb: plan.diskMb,
        ioWeight: plan.ioWeight,
      },
      allocations: [{ ip: created.allocation.ip, port: created.allocation.port, primary: true }],
      installImage: template.installImage || DEFAULT_INSTALL_IMAGE,
      installEntrypoint: template.installEntrypoint || DEFAULT_INSTALL_ENTRYPOINT,
      installScript: template.installScript,
    });

    return { id: created.server.id, shortId: created.server.shortId, status: created.server.status };
  }

  private async dispatchToAgent(serverId: string, nodeId: string, payload: CreateAgentServerRequest): Promise<void> {
    try {
      await this.agent.createServer(nodeId, payload);
    } catch (err) {
      // The create TRANSACTION already committed — the server row exists
      // with allocation/limits reserved. A dispatch failure (agent
      // unreachable, bad request) is reported the same way an install
      // failure reported BY the agent would be: install_failed, with the
      // reason recorded in the audit trail, never a silent stuck
      // "installing" row.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.server.update({ where: { id: serverId }, data: { status: 'install_failed' } }),
      );
      await this.audit.record({
        action: 'server.create.dispatch_failed',
        targetType: 'server',
        targetId: serverId,
        metadata: { error: (err as Error).message },
      });
    }
  }

  /**
   * Hard-deletes a server (architecture doc 2.2: servers are hard-deleted,
   * never soft — a ghost row would inflate disk/allocation quotas
   * forever). Self-service deletion is off by default (architecture doc
   * 9.4); this is the admin/automation path.
   *
   * Order matters: the real, external resources (the agent's Docker
   * container, each database's schema+user on its MySQL host) are torn
   * down FIRST, while the row we need their identifiers from still
   * exists. The agent teardown must SUCCEED before anything else
   * happens — "hard-deleted once the agent confirms teardown" is not
   * negotiable, an unreachable node must never silently orphan a running
   * container. Database teardown is best-effort per the reasoning in
   * DatabasesService.deleteAllForServer — one bad host must never block
   * the whole deletion, but every failure is audited.
   */
  async remove(id: string): Promise<void> {
    const server = await this.get(id);

    await this.agent.deleteServer(server.node.id, server.id);

    const { droppedCount, failures } = await this.databases.deleteAllForServer(server.id);

    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      await tx.allocation.updateMany({ where: { serverId: server.id }, data: { isPrimary: false } });
      await tx.server.delete({ where: { id: server.id } });
    });

    await this.audit.record({
      action: 'server.delete',
      targetType: 'server',
      targetId: server.id,
      metadata: { databasesDropped: droppedCount, databaseDropFailures: failures },
    });
  }

  /**
   * Suspend/restore (architecture doc roadmap M14) — the panel-side half
   * of TWO independent enforcement points, the other being the agent's
   * own `IsSuspended` flag (agent/internal/srv/suspend.go). Idempotent
   * by design: setting the SAME status again is a harmless no-op update,
   * which is exactly what lets BillingWebhookService call this without
   * first checking current state — a retried webhook delivery for an
   * already-suspended server just re-writes the same row.
   *
   * The agent push is best-effort, same posture as every other
   * dispatch-after-commit in this service: the DB row is the panel's
   * own source of truth (ServerAccessService.can() gates on it
   * directly), so a node that's briefly unreachable doesn't leave the
   * SUSPENSION itself in doubt — only the live container's immediate
   * teardown lags until the node comes back and the agent's own
   * heartbeat-driven reconciliation (or a retried suspend call) catches
   * it up.
   *
   * actorId is nullable: an admin-triggered suspend has a real one, but
   * BillingWebhookService's calls don't — no human initiated those, and
   * `audit_logs.actor_id` is a real FK to `users`, so passing anything
   * other than a genuine user id or null would fail at the database
   * (found while writing BillingWebhookService: a placeholder string
   * like `"billing-webhook"` isn't a valid uuid). The audit row itself
   * still fully identifies a billing-driven suspension via `action`
   * ('admin.server.suspend') and `metadata.reason` ('billing: <event
   * type>') — a null actor reads as "the system did this," not "we lost
   * track of who."
   */
  async suspend(id: string, reason: string, actorId: string | null): Promise<void> {
    const server = await this.get(id);
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.update({ where: { id }, data: { status: 'suspended', suspendedAt: new Date(), suspensionReason: reason } }),
    );
    await this.audit.record({ action: 'admin.server.suspend', actorId, targetType: 'server', targetId: id, metadata: { reason } });
    await this.agent.setSuspended(server.node.id, id, true).catch((err) => {
      void this.audit.record({ action: 'admin.server.suspend.agent_push_failed', actorId, targetType: 'server', targetId: id, metadata: { error: (err as Error).message } });
    });
  }

  async unsuspend(id: string, actorId: string | null): Promise<void> {
    const server = await this.get(id);
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.update({ where: { id }, data: { status: 'ready', suspendedAt: null, suspensionReason: null } }),
    );
    await this.audit.record({ action: 'admin.server.unsuspend', actorId, targetType: 'server', targetId: id });
    await this.agent.setSuspended(server.node.id, id, false).catch((err) => {
      void this.audit.record({ action: 'admin.server.unsuspend.agent_push_failed', actorId, targetType: 'server', targetId: id, metadata: { error: (err as Error).message } });
    });
  }

  /** Called by the agent (NodeAuthGuard) when an install run finishes. */
  async reportInstallResult(nodeId: string, serverUuid: string, successful: boolean, errorMessage?: string): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const server = await tx.server.findFirst({ where: { id: serverUuid, nodeId } });
      if (!server) throw new NotFoundException('Server not found on this node');

      await tx.server.update({
        where: { id: serverUuid },
        data: successful
          ? { status: 'ready', installedAt: new Date() }
          : { status: 'install_failed' },
      });
    });

    await this.audit.record({
      action: successful ? 'server.install.completed' : 'server.install.failed',
      targetType: 'server',
      targetId: serverUuid,
      metadata: successful ? {} : { errorMessage },
    });
  }

  /**
   * Called by the agent (NodeAuthGuard) to attribute a WS-driven power
   * action to the panel's activity feed (architecture doc roadmap M11 —
   * see agent/internal/panel/client.go's ReportActivity doc comment for
   * why this is the only place that ever learns both "it happened" and
   * "who authorized it"). Same node-ownership check as
   * reportInstallResult, for the same reason: the calling node's own
   * bearer token proves it IS a node, not that it owns THIS server.
   */
  async reportRemoteActivity(nodeId: string, serverUuid: string, userId: string, event: string, properties?: Record<string, unknown>): Promise<void> {
    const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.findFirst({ where: { id: serverUuid, nodeId } }));
    if (!server) throw new NotFoundException('Server not found on this node');
    await this.activity.record({ actorId: userId, serverId: serverUuid, event, properties });
  }
}

/** Exported for TransfersService (roadmap M13) — the target node's capacity check reuses the exact same math the create transaction uses. */
export function assertCapacity(
  label: string,
  used: number,
  requested: number,
  totalMb: number,
  reservedMb: number,
  overallocatePct: number,
): void {
  if (overallocatePct === -1) return; // unlimited
  const ceiling = (totalMb - reservedMb) * (1 + overallocatePct / 100);
  if (used + requested > ceiling) {
    throw new ConflictException(
      `NO_CAPACITY: node ${label} would be ${used + requested}MB, ceiling is ${Math.floor(ceiling)}MB`,
    );
  }
}

/** Exported for TransfersService (roadmap M13) — picking the target node's allocation is the identical FOR UPDATE SKIP LOCKED query. */
export async function pickFreeAllocation(tx: Prisma.TransactionClient, nodeId: string) {
  // FOR UPDATE SKIP LOCKED under the node's advisory lock: even without
  // the advisory lock this would prevent two transactions from picking
  // the SAME row, but the advisory lock is still what makes the capacity
  // check above race-free — allocation picking has its own, independent
  // protection here as a second layer.
  // host(ip), not ip::text: Postgres's inet type carries an implicit /32
  // netmask, and ::text renders it ("203.0.113.50/32") — which Docker's
  // daemon then rejects outright when building the container's port
  // bindings (confirmed live: "ParseAddr(...): unexpected character (at
  // "/32")"). host() strips the mask, returning the bare address the
  // agent actually expects.
  const rows = await tx.$queryRaw<{ id: bigint; ip: string; port: number }[]>`
    SELECT id, host(ip) as ip, port FROM allocations
    WHERE node_id = ${nodeId}::uuid AND server_id IS NULL
    ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
  `;
  return rows[0] ?? null;
}

async function generateUniqueShortId(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShortId();
    const existing = await tx.server.findFirst({ where: { shortId: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new ConflictException('Could not allocate a unique short_id, please retry');
}
