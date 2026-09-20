import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { BootstrapRequestDto, HeartbeatDto } from './dto/node.dto';
import { deriveHealthStatus } from './nodes.service';

const BOOTSTRAP_TTL_SECONDS = 30 * 60; // 30 min, single-use
const HEARTBEAT_INTERVAL_SECONDS = 15;
// How long a server may be absent from a node's reported inventory before
// the sweep treats it as genuinely missing. Sized well above the agent's
// own 5-minute orphan-reconcile interval so a server only ever gets
// flagged after at least one full tick it could have appeared in, and
// comfortably above the create dispatch's own window (the API's create
// call and the agent's Register are not atomic).
const INVENTORY_GRACE_MS = 15 * 60 * 1000;

/**
 * The node provisioning handshake (architecture doc 4.2/7): an admin
 * mints a single-use bootstrap token; the agent presents it exactly once
 * to trade it for a long-lived node token. The bootstrap token itself
 * lives only in Redis (never the database) — it's a 30-minute-TTL,
 * burn-on-use credential, not a record anyone needs to audit or revoke
 * later, so it doesn't deserve a table.
 */
@Injectable()
export class NodeBootstrapService {
  private readonly logger = new Logger(NodeBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  static controlTokenAad(nodeId: string): string {
    return `nodes:control_token_enc:${nodeId}`;
  }

  async issueBootstrapToken(
    nodeId: string,
    actorId: string,
  ): Promise<{ token: string; expiresAt: Date; command: string }> {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node not found');

    const token = `bst_${randomBytes(24).toString('base64url')}`;
    const key = bootstrapRedisKey(token);
    await this.redis.client.set(key, nodeId, 'EX', BOOTSTRAP_TTL_SECONDS);

    const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_SECONDS * 1000);
    await this.audit.record({ action: 'admin.node.bootstrap_token_issued', actorId, targetType: 'node', targetId: nodeId });

    return {
      token,
      expiresAt,
      command: `pxagent bootstrap --panel <panel-url> --token ${token}`,
    };
  }

  async bootstrap(dto: BootstrapRequestDto): Promise<{ nodeUuid: string; nodeToken: string; heartbeatIntervalSeconds: number }> {
    const key = bootstrapRedisKey(dto.token);
    const nodeId = await this.redis.client.get(key);
    if (!nodeId) throw new UnauthorizedException('Invalid or expired bootstrap token');
    // Single-use: burn it immediately, before doing anything else, so a
    // retried/duplicated request can't mint two node tokens from one
    // bootstrap token racing the delete.
    await this.redis.client.del(key);

    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node no longer exists');

    // Revoke any existing active token for this node — a re-bootstrap
    // (e.g. after `pxagent bootstrap` is re-run) supersedes the old
    // credential rather than accumulating two "active" tokens, which the
    // `node_tokens_one_active` partial unique index would reject anyway.
    await this.prisma.nodeToken.updateMany({
      where: { nodeId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    // 12 raw bytes -> exactly 16 base64url characters (12*4/3, no padding),
    // matching the `token_id CHAR(16)` column precisely.
    const tokenId = randomBytes(12).toString('base64url');
    const secret = randomBytes(36).toString('base64url');
    const tokenHash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

    const fullToken = `${tokenId}.${secret}`;

    await this.prisma.nodeToken.create({
      data: { nodeId, tokenId, tokenHash, status: 'active' },
    });
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        dockerVersion: dto.dockerVersion,
        lastHeartbeatAt: new Date(),
        healthStatus: 'online',
        controlTokenEnc: Buffer.from(this.crypto.encrypt(fullToken, NodeBootstrapService.controlTokenAad(nodeId)), 'utf8'),
      },
    });

    await this.audit.record({
      action: 'node.bootstrap.completed',
      targetType: 'node',
      targetId: nodeId,
      metadata: { hostname: dto.hostname, os: dto.os, kernel: dto.kernel, dockerVersion: dto.dockerVersion, arch: dto.arch },
    });

    return { nodeUuid: nodeId, nodeToken: fullToken, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS };
  }

  /**
   * Agent-initiated self-rotation (architecture doc roadmap M13: "token
   * rotation"). Called with the node's CURRENT still-valid token
   * (NodeAuthGuard already proved possession by the time this runs) —
   * the response hands back a fresh one in the SAME round trip, so the
   * agent never has a moment without a working credential: it applies
   * the new token in memory and rewrites node.json before its NEXT
   * outbound call, and this method updates `controlTokenEnc` (what the
   * panel sends back to the agent) in the same breath, so both
   * directions agree on the new secret before either side's next call.
   * The old token is revoked in the SAME transaction that creates the
   * new one, matching `node_tokens_one_active`'s partial unique index —
   * Postgres would reject two simultaneously-active rows for one node
   * even if this tried to leave a real overlap window open.
   */
  async rotateSelf(nodeId: string): Promise<{ nodeToken: string }> {
    const tokenId = randomBytes(12).toString('base64url');
    const secret = randomBytes(36).toString('base64url');
    const tokenHash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const fullToken = `${tokenId}.${secret}`;

    await this.prisma.$transaction([
      this.prisma.nodeToken.updateMany({ where: { nodeId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } }),
      this.prisma.nodeToken.create({ data: { nodeId, tokenId, tokenHash, status: 'active' } }),
      this.prisma.node.update({
        where: { id: nodeId },
        data: { controlTokenEnc: Buffer.from(this.crypto.encrypt(fullToken, NodeBootstrapService.controlTokenAad(nodeId)), 'utf8') },
      }),
    ]);

    await this.audit.record({ action: 'node.token.self_rotated', targetType: 'node', targetId: nodeId });
    return { nodeToken: fullToken };
  }

  /**
   * Admin-forced revocation — the "credential compromised, kill it now"
   * path, distinct from rotateSelf above: there is no way to hand a
   * fresh token to an agent that might be unreachable or the very thing
   * being revoked FOR, so this deliberately does NOT try. It revokes the
   * active token immediately (the node's next heartbeat 401s) and issues
   * a fresh bootstrap token so an operator can manually re-bootstrap,
   * exactly like onboarding a brand new node.
   */
  async forceRotate(nodeId: string, actorId: string): Promise<{ token: string; expiresAt: Date; command: string }> {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node not found');

    await this.prisma.nodeToken.updateMany({ where: { nodeId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
    await this.audit.record({ action: 'node.token.force_revoked', actorId, targetType: 'node', targetId: nodeId });

    return this.issueBootstrapToken(nodeId, actorId);
  }

  /**
   * Capacity plan Fase 7: `dto`'s `reported_*` fields (and `uptimeSeconds`,
   * accepted-and-discarded since M4) are now actually persisted. Every
   * field is passed straight through as `undefined` when the agent
   * didn't send it — Prisma's `update` leaves an `undefined` field
   * completely untouched rather than nulling it out, so a heartbeat from
   * an agent binary older than this milestone (or one where a single
   * telemetry source failed this tick — see the agent's own `send()`)
   * changes nothing about columns it has no data for. `reportedAt` is
   * the one exception: it's only bumped when at least one `reported_*`
   * field actually arrived, so it stays a true "last real telemetry"
   * timestamp instead of updating on every heartbeat regardless of
   * content.
   */
  async heartbeat(nodeId: string, dto: HeartbeatDto): Promise<{ status: string }> {
    const hasReportedFields =
      dto.reportedMemoryTotalMb !== undefined ||
      dto.reportedMemoryLimitMb !== undefined ||
      dto.reportedCpuCount !== undefined ||
      dto.reportedDiskTotalMb !== undefined ||
      dto.reportedDiskFreeMb !== undefined ||
      dto.reportedOs !== undefined ||
      dto.reportedKernel !== undefined ||
      dto.reportedContainersRunning !== undefined ||
      dto.reportedCpuModel !== undefined ||
      dto.reportedCpuSockets !== undefined ||
      dto.reportedCpuPhysicalCores !== undefined ||
      dto.reportedCpuUsagePercent !== undefined ||
      dto.reportedLoadAvg1 !== undefined ||
      dto.reportedMemoryUsedMb !== undefined ||
      dto.reportedMemoryAvailableMb !== undefined ||
      dto.reportedVirtualizationSystem !== undefined ||
      dto.reportedVirtualizationRole !== undefined;

    // Capacity plan (auto-derivation) §21 case 11: only the THREE fields
    // resolveNodeCapacity actually feeds into a ceiling (memory
    // limit/total, disk total, cpu count) are worth auditing when they
    // change — every other reported_* field (CPU model string, load
    // average, ...) changing tick to tick is normal noise, not a
    // capacity-relevant event. Fetched before the write so `before` is
    // genuinely the PRIOR value, not the one this same call is about to
    // set.
    const before = await this.prisma.node.findFirst({
      where: { id: nodeId },
      select: { reportedMemoryLimitMb: true, reportedMemoryTotalMb: true, reportedDiskTotalMb: true, reportedCpuCount: true },
    });

    const node = await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        lastHeartbeatAt: new Date(),
        healthStatus: 'online',
        agentVersion: dto.agentVersion,
        dockerVersion: dto.dockerVersion,
        agentUptimeSeconds: dto.uptimeSeconds,
        reportedMemoryTotalMb: dto.reportedMemoryTotalMb,
        reportedMemoryLimitMb: dto.reportedMemoryLimitMb,
        reportedCpuCount: dto.reportedCpuCount,
        reportedDiskTotalMb: dto.reportedDiskTotalMb,
        reportedDiskFreeMb: dto.reportedDiskFreeMb,
        reportedOs: dto.reportedOs,
        reportedKernel: dto.reportedKernel,
        reportedContainersRunning: dto.reportedContainersRunning,
        reportedCpuModel: dto.reportedCpuModel,
        reportedCpuSockets: dto.reportedCpuSockets,
        reportedCpuPhysicalCores: dto.reportedCpuPhysicalCores,
        reportedCpuUsagePercent: dto.reportedCpuUsagePercent,
        reportedLoadAvg1: dto.reportedLoadAvg1,
        reportedMemoryUsedMb: dto.reportedMemoryUsedMb,
        reportedMemoryAvailableMb: dto.reportedMemoryAvailableMb,
        reportedVirtualizationSystem: dto.reportedVirtualizationSystem,
        reportedVirtualizationRole: dto.reportedVirtualizationRole,
        ...(hasReportedFields ? { reportedAt: new Date() } : {}),
      },
    });

    if (
      before &&
      (before.reportedMemoryLimitMb !== node.reportedMemoryLimitMb ||
        before.reportedMemoryTotalMb !== node.reportedMemoryTotalMb ||
        before.reportedDiskTotalMb !== node.reportedDiskTotalMb ||
        before.reportedCpuCount !== node.reportedCpuCount)
    ) {
      // No actorId — this is the agent's own heartbeat, not an admin
      // action (same posture as every other agent-originated write in
      // this file: bootstrap's audit entries are actor-attributed
      // because an ADMIN triggered them, this one has no human behind
      // it). Fires at most once per genuine hardware change, not every
      // tick — the comparison above is against the row's PRIOR value.
      await this.audit.record({
        action: 'node.telemetry.changed',
        targetType: 'node',
        targetId: nodeId,
        beforeState: { reportedMemoryLimitMb: before.reportedMemoryLimitMb, reportedMemoryTotalMb: before.reportedMemoryTotalMb, reportedDiskTotalMb: before.reportedDiskTotalMb, reportedCpuCount: before.reportedCpuCount },
        afterState: { reportedMemoryLimitMb: node.reportedMemoryLimitMb, reportedMemoryTotalMb: node.reportedMemoryTotalMb, reportedDiskTotalMb: node.reportedDiskTotalMb, reportedCpuCount: node.reportedCpuCount },
      });
    }

    await this.syncServerPowerStates(nodeId, dto.servers);

    return { status: deriveHealthStatus(node.lastHeartbeatAt) };
  }

  /**
   * The authoritative "what should still exist on this node" list for the
   * agent's own orphan-reconciliation sweep (agent/internal/srv/reconcile.go).
   * Found live: `servers` are hard-deleted the moment the panel confirms
   * agent teardown (architecture doc 2.2), but the agent's in-memory
   * server registry is never persisted — an agent restart drops it
   * entirely while a container it was tracking keeps running untouched.
   * If a delete then arrives (or already arrived, while the agent was
   * down) for a server whose container the agent no longer has a record
   * of, nothing else it ever hears from the panel again gives it a chance
   * to notice; this endpoint is what its periodic sweep diffs Docker's
   * own container labels against to catch that case on its own. No
   * `deletedAt` filter needed: unlike most tables in this schema, `servers`
   * has no soft delete, so every row returned here is genuinely still
   * live.
   */
  async listServerUuids(nodeId: string): Promise<{ serverUuids: string[] }> {
    // `servers` is RLS-protected (PrismaService's own doc comment) — a
    // bare `this.prisma.server.findMany` here would silently return an
    // empty list on every call, no error, nothing to notice in a log.
    // That's not just wrong, it's actively dangerous for THIS endpoint
    // specifically: the agent's orphan sweep (srv.ReconcileOrphans) treats
    // "not in this list" as "safe to force-remove", so an empty list back
    // here would make it tear down every container on the node on its
    // very next tick. Same withRLS(admin) context every other
    // agent-initiated system call in ServersService already uses (see
    // reportInstallResult/findServerForNode) — there is no end user
    // behind this request to scope it to.
    const servers = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findMany({ where: { nodeId }, select: { id: true } }),
    );
    return { serverUuids: servers.map((s) => s.id) };
  }

  /**
   * The second half of the reconciliation loop, which did not exist
   * before: `listServerUuids` above tells the agent what SHOULD be on a
   * node, and the agent's sweep tears down containers that shouldn't be.
   * Nothing ever checked the reverse — a server this panel still lists
   * whose container is gone from the node. It sat in `installing` forever
   * (there is no stuck-install watchdog either) while every operation on
   * it answered SERVER_NOT_FOUND, with no way back short of manual
   * intervention. Seen live on a real server stuck `installing` for 12
   * hours after its container was removed and the agent restarted —
   * that restart rebuilds the agent's registry from Docker labels alone,
   * so a server with no container is simply forgotten.
   *
   * Only `installing` is auto-transitioned, and only to `install_failed`
   * — a recoverable state the client can already retry from
   * (ServerSetupService.complete accepts it). A `ready` server whose
   * container vanished is also broken, but its world data is still on
   * disk and the fix is recreating a container, not re-running an
   * install; rewriting its status would erase that distinction, so it is
   * audited and logged for an operator instead of mutated.
   * `setup_pending` is skipped entirely — it has no container BY DESIGN.
   */
  async reconcileNodeInventory(nodeId: string, reportedUuids: string[]): Promise<{ flagged: number }> {
    const present = new Set(reportedUuids);
    // A server dispatched seconds ago is legitimately not on the node yet
    // (the API's create call and the agent's Register are not atomic) and
    // this sweep runs every 5 minutes. Without this window a brand-new
    // server would race straight into 'install_failed' on the first tick.
    const cutoff = new Date(Date.now() - INVENTORY_GRACE_MS);

    const candidates = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findMany({
        where: { nodeId, status: { in: ['installing', 'ready', 'suspended'] }, updatedAt: { lt: cutoff } },
        select: { id: true, name: true, status: true },
      }),
    );

    const missing = candidates.filter((c) => !present.has(c.id));
    if (missing.length === 0) return { flagged: 0 };

    const stuckInstalls = missing.filter((m) => m.status === 'installing');
    if (stuckInstalls.length > 0) {
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.server.updateMany({
          where: { id: { in: stuckInstalls.map((s) => s.id) }, nodeId, status: 'installing' },
          data: { status: 'install_failed' },
        }),
      );
    }

    for (const m of missing) {
      this.logger.warn(`server ${m.id} (${m.name}) is '${m.status}' on the panel but absent from node ${nodeId}`);
      await this.audit.record({
        action: 'node.inventory.server_missing',
        targetType: 'server',
        targetId: m.id,
        metadata: { nodeId, previousStatus: m.status, transitionedTo: m.status === 'installing' ? 'install_failed' : null },
      });
    }

    return { flagged: missing.length };
  }

  /**
   * The ONLY writer of `servers.power_state`. Before this existed the
   * column had no writer at all: it sat at its `'offline'` schema default
   * from the moment a row was created, so the panel showed every server
   * as offline while its container ran, and a version change's "server
   * must be offline" precondition could never reject anything (the
   * agent's own ErrServerNotStopped was the only thing actually
   * enforcing it).
   *
   * Scoped to `nodeId`: a node may only ever speak for the servers it
   * hosts. Without that, a compromised or simply misconfigured agent
   * could rewrite the power state of every server on the platform.
   *
   * Never deletes or defaults anything for a server the payload omits —
   * the agent deliberately omits a server mid-Docker-call (see
   * srv.Manager.States), and an absent entry means "no news", never
   * "offline". Same best-effort contract as the node telemetry above.
   */
  private async syncServerPowerStates(nodeId: string, reported?: { uuid: string; state: string }[]): Promise<void> {
    if (!reported?.length) return;

    const byState = new Map<string, string[]>();
    for (const { uuid, state } of reported) {
      const ids = byState.get(state);
      if (ids) ids.push(uuid);
      else byState.set(state, [uuid]);
    }

    const now = new Date();
    try {
      // `servers` is a tenant table under RLS, so this needs an explicit
      // admin context like every other agent-originated write — the
      // policies apply just as unforgivingly to code that forgot to set
      // it (PrismaService.withRLS's own doc comment). There is no human
      // behind a heartbeat, hence `userId: null`.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
        // One updateMany per DISTINCT state, not per server: a node with
        // 100 servers reporting every 15s is 2-3 statements here instead
        // of 100. `powerState: { not: state }` makes each one a genuine
        // no-op when nothing changed, so `power_state_at` stays a real
        // "when it last CHANGED" timestamp rather than being rewritten
        // every tick — which is what makes it usable for "offline since".
        for (const [state, ids] of byState) {
          await tx.server.updateMany({
            where: { id: { in: ids }, nodeId, powerState: { not: state } },
            data: { powerState: state, powerStateAt: now },
          });
        }
      });
    } catch (err) {
      // Never fail the heartbeat over this: the node's own health status
      // (and therefore whether the panel considers it reachable at all)
      // rides on this same call succeeding.
      this.logger.warn(`power state sync failed for node ${nodeId}: ${(err as Error).message}`);
    }
  }
}

function bootstrapRedisKey(token: string): string {
  // Store by hash, not the raw token, matching the general rule that a
  // credential value never sits in cleartext at rest — even in Redis,
  // even for a 30-minute-lived one.
  return `bootstrap:${createHash('sha256').update(token).digest('hex')}`;
}
