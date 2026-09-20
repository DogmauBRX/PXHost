import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServerTemplate } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient, CreateAgentServerRequest, ReinstallAgentServerRequest } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { DatabasesService } from '../databases/databases.service';
import { ActivityService } from '../activity/activity.service';
import { CapacityService } from '../capacity/capacity.service';
import { assertNodeFits, assertSlots, nodeAcceptsNewServers, resolveNodeCapacity } from '../capacity/capacity.math';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { NodeSchedulerService, SchedulerCandidate } from '../scheduler/node-scheduler.service';
import { GatewayService } from '../gateway/gateway.service';
import { CreateServerDto, CreateSetupPendingServerInput } from './dto/server.dto';
import { generateShortId } from './short-id';
import { pickDockerImage } from '../templates/software-presets';
import { validateVariableValue } from './variable-rules';

// Exported for ServerSetupService, which builds the exact same
// CreateAgentServerRequest shape for the post-setup dispatch — the
// schema column already defaults to DEFAULT_INSTALL_IMAGE, so this is
// belt-and-suspenders for a row written before that default existed, not
// a real fallback path either caller expects to hit.
export const DEFAULT_INSTALL_IMAGE = 'ghcr.io/parkervcp/installers:debian';
export const DEFAULT_INSTALL_ENTRYPOINT = 'bash';

/**
 * The subset of `CreateServerDto` that `createOnNode`'s reservation
 * transaction actually needs — `CreateServerDto` (admin/legacy path,
 * `template` resolved by the caller) and `CreateSetupPendingServerInput`
 * (post-purchase path, no template yet) both satisfy this structurally,
 * with no cast required at either call site.
 */
interface CreateOnNodeInput {
  ownerId: string;
  planId: string;
  name?: string;
  variables?: Record<string, string>;
  allocationId?: string;
  attachSubscriptionId?: string;
}

/** Default page size for `ServersService.list` when the caller doesn't pass `limit` — bounds what used to be a fully unbounded query (every server in the system, admin-wide) to something a request can always serve quickly. Mirrors `ListUsersDto`'s own 100 default/200 cap, sized a bit larger since a server row is lighter than a user row. */
const DEFAULT_LIST_LIMIT = 200;

/** How many DIFFERENT nodes an automatic (no explicit `dto.nodeId`) create will try before giving up — see `ServersService.create`'s doc comment for why an explicit `nodeId` never retries at all. */
const MAX_SCHEDULER_ATTEMPTS = 3;

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly databases: DatabasesService,
    private readonly activity: ActivityService,
    private readonly capacity: CapacityService,
    private readonly scheduler: NodeSchedulerService,
    private readonly gateway: GatewayService,
  ) {}

  /**
   * `template` was previously pulled in full via `include` (multi-KB
   * `dockerImages`/`configFiles`/`configStartup`/`configLogs` JSON blobs
   * and a full `installScript` string per row) even though nothing in
   * `AdminServerSummary` (the frontend type this feeds) reads it — dropped
   * entirely here. `node`/`plan` are narrowed to just the id/name pair that
   * type actually declares. `take` defaults to `DEFAULT_LIST_LIMIT` instead
   * of being unbounded, since this had no pagination at all before and an
   * admin-wide call with no `ownerId` returns literally every server row
   * in the system.
   */
  async list(ownerId?: string, take = DEFAULT_LIST_LIMIT, skip = 0) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findMany({
        where: ownerId ? { ownerId } : undefined,
        select: {
          id: true,
          shortId: true,
          name: true,
          status: true,
          node: { select: { id: true, name: true } },
          plan: { select: { id: true, name: true } },
          owner: { select: { id: true, username: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
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
          publicRoute: { include: { gateway: { select: { id: true, name: true, publicHost: true } } } },
          variables: { include: { variable: true } },
          owner: { select: { id: true, username: true, email: true } },
        },
      }),
    );
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  /**
   * Capacity plan Fase 5: `dto.nodeId` is now optional. Explicit vs.
   * automatic is a hard branch, not a fallback chain:
   *
   * - **Explicit `nodeId`**: goes straight to `createOnNode`, once, no
   *   retry. Silently reallocating a server the admin deliberately
   *   pinned to a node would be worse than the error.
   * - **Automatic**: `NodeSchedulerService.selectNode` picks a
   *   candidate (unlocked — a hint, see its own doc comment),
   *   `createOnNode` re-verifies everything for real under lock. If
   *   THAT fails for a reason other than `NO_SLOTS`, the chosen node is
   *   excluded and selection runs again, in a brand-new transaction, up
   *   to `MAX_SCHEDULER_ATTEMPTS` times. `NO_SLOTS` is never retried —
   *   the plan is out of stock globally, and no other node changes that.
   */
  async create(dto: CreateServerDto): Promise<{ id: string; shortId: string; status: string }> {
    const owner = await this.prisma.user.findFirst({ where: { id: dto.ownerId, deletedAt: null } });
    if (!owner) throw new NotFoundException('Owner not found');

    // `dto.templateId` omitted ⇒ same 'setup_pending' path
    // createSetupPending uses for checkout: the admin reserves the
    // slot/allocation now, the owner picks software later via
    // ServerSetupService.complete (see createOnNode's own doc comment
    // for how `templateContext: null` flows through it).
    let templateContext: { template: ServerTemplate; dockerImage: string } | null = null;
    if (dto.templateId) {
      const template = await this.prisma.serverTemplate.findFirst({ where: { id: dto.templateId, deletedAt: null } });
      if (!template) throw new NotFoundException('Template not found');
      // `isActive` existed on the column since the template CRUD shipped but
      // nothing ever read it — an admin toggling a template off believed
      // (wrongly) that it stopped new servers from using it. Enforced here,
      // once, for every creation path (admin panel and, soon, the customer
      // checkout) rather than duplicated per-caller.
      if (!template.isActive) throw new ConflictException('Template is not active');

      const images = template.dockerImages as Record<string, string>;
      // Version-aware: a modded server on the wrong Java dies during mod
      // loading, not at startup — see pickDockerImage's doc comment.
      const dockerImage = pickDockerImage(images, dto.variables?.MINECRAFT_VERSION);
      if (!dockerImage) throw new ConflictException('Template has no docker images configured');
      templateContext = { template, dockerImage };
    }

    const planExists = await this.prisma.plan.findFirst({ where: { id: dto.planId, deletedAt: null }, select: { id: true } });
    if (!planExists) throw new NotFoundException('Plan not found');

    return this.withSchedulerRetry(dto.planId, dto.nodeId, (nodeId, candidates) =>
      this.createOnNode(dto, nodeId, templateContext, candidates),
    );
  }

  /**
   * Post-purchase provisioning (payments plan): reserves a plan slot and
   * node RAM/disk/CPU/allocation/uid for a subscription — same
   * capacity-checked transaction as `create`/`createOnNode` — but does
   * NOT choose a software/version yet and never dispatches to the agent.
   * `Server.status` starts at 'setup_pending', with
   * templateId/dockerImage/startupCommand all NULL (see schema's
   * `servers_setup_consistency` CHECK). The customer completes setup
   * later via `ServerSetupService.complete`, the only path that ever
   * moves a 'setup_pending' row forward — nothing here ever talks to the
   * agent, which is exactly what keeps CPU/RAM at zero until then.
   */
  async createSetupPending(input: CreateSetupPendingServerInput): Promise<{ id: string; shortId: string; status: string }> {
    const owner = await this.prisma.user.findFirst({ where: { id: input.ownerId, deletedAt: null } });
    if (!owner) throw new NotFoundException('Owner not found');

    const planExists = await this.prisma.plan.findFirst({ where: { id: input.planId, deletedAt: null }, select: { id: true } });
    if (!planExists) throw new NotFoundException('Plan not found');

    return this.withSchedulerRetry(input.planId, input.nodeId, (nodeId, candidates) =>
      this.createOnNode(input, nodeId, null, candidates),
    );
  }

  /**
   * Explicit vs. automatic node selection, shared by `create` and
   * `createSetupPending` — extracted so the retry policy (capacity plan
   * Fase 5's own doc comment, reproduced below) can never drift between
   * the two callers:
   *
   * - **Explicit `nodeId`**: goes straight to `attempt`, once, no retry.
   *   Silently reallocating a server the admin deliberately pinned to a
   *   node would be worse than the error.
   * - **Automatic**: `NodeSchedulerService.selectNode` picks a candidate
   *   (unlocked — a hint, see its own doc comment), `attempt` (which
   *   re-verifies everything for real under lock) runs. If THAT fails
   *   for a reason other than `NO_SLOTS`, the chosen node is excluded
   *   and selection runs again, in a brand-new transaction, up to
   *   `MAX_SCHEDULER_ATTEMPTS` times. `NO_SLOTS` is never retried — the
   *   plan is out of stock globally, and no other node changes that.
   */
  private async withSchedulerRetry<T>(
    planId: string,
    nodeId: string | undefined,
    attempt: (nodeId: string, schedulerCandidates: SchedulerCandidate[] | null) => Promise<T>,
  ): Promise<T> {
    if (nodeId) return attempt(nodeId, null);

    const excluded: string[] = [];
    for (let i = 1; i <= MAX_SCHEDULER_ATTEMPTS; i++) {
      const selection = await this.scheduler.selectNode(planId, { excludeNodeIds: excluded });
      if (!selection.selected) {
        throw new ConflictException('No eligible node found for this plan');
      }
      try {
        return await attempt(selection.selected.nodeId, selection.candidates);
      } catch (err) {
        if (err instanceof ConflictException && typeof err.message === 'string' && err.message.startsWith('NO_SLOTS:')) {
          throw err; // plan is out of stock everywhere — trying another node never helps
        }
        excluded.push(selection.selected.nodeId);
        if (i === MAX_SCHEDULER_ATTEMPTS) throw err;
      }
    }
    // Unreachable — the loop above always returns or throws — but TypeScript
    // can't see that a `for` loop with a `throw` on its last iteration is
    // exhaustive.
    throw new ConflictException('No eligible node found for this plan');
  }

  /**
   * The M5 create transaction (architecture doc 2.6/4.4/roadmap M5):
   * capacity check + allocation reservation + limit snapshot, all under
   * one advisory lock on the node so two concurrent creates can never
   * both pass the same capacity check — proven by
   * servers.concurrency.spec.ts's race test, not just asserted here.
   *
   * Capacity plan Fase 4: a PLAN lock is now taken first, strictly
   * before the node lock — see capacity.locks.ts's ordering invariant.
   * Without it, two concurrent creates of the SAME plan on DIFFERENT
   * nodes take disjoint node locks and can both read "one slot left"
   * before either commits, overselling the plan even though each
   * individual node's own capacity check was perfectly race-free.
   *
   * The Docker-side work (pull, create, install) happens AFTER this
   * transaction commits, via AgentClient — a slow or unreachable agent
   * must never hold the node's capacity lock.
   */
  private async createOnNode(
    dto: CreateOnNodeInput,
    nodeId: string,
    // NULL for the post-purchase path (createSetupPending): the row is
    // created with status 'setup_pending' and no template/variables at
    // all, and dispatchToAgent below is skipped entirely.
    templateContext: { template: ServerTemplate; dockerImage: string } | null,
    schedulerCandidates: SchedulerCandidate[] | null,
  ): Promise<{ id: string; shortId: string; status: string }> {
    const created = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      // Plan lock strictly before node lock (see this method's own doc
      // comment). The plan row is re-read HERE, under the lock — not the
      // `planExists` check above — so `maxSlots` (and every other field
      // used to build the server below) reflects whatever an admin's
      // concurrent edit last committed, the same freshness guarantee the
      // node row already gets from its own re-read after `lockNode`.
      await this.capacity.lockPlan(tx, dto.planId);
      const plan = await tx.plan.findFirst({ where: { id: dto.planId, deletedAt: null } });
      if (!plan) throw new NotFoundException('Plan not found');

      const occupied = await this.capacity.occupiedSlots(tx, dto.planId);
      assertSlots(occupied, plan.maxSlots);

      const allowedOnNode = await this.capacity.isNodeAllowedForPlan(tx, dto.planId, nodeId);
      if (!allowedOnNode) throw new ConflictException('This plan is not allowed on the requested node');

      // Every capacity check + allocation pick for this node is
      // serialized by this lock for the duration of the transaction —
      // this is what makes two concurrent creates unable to both read
      // "capacity available" before either has committed its own usage.
      await this.capacity.lockNode(tx, nodeId);

      const node = await tx.node.findFirst({ where: { id: nodeId, deletedAt: null } });
      if (!node) throw new NotFoundException('Node not found');

      // Capacity plan (auto-derivation): resolveNodeCapacity is the ONE
      // place that decides auto-vs-manual — every node created before
      // this feature is 'manual', for which nodeAcceptsNewServers checks
      // EXACTLY the maintenanceMode gate this line always had, so no
      // existing node's create behavior changes. 'auto' additionally
      // refuses when the telemetry behind the ceiling below can't be
      // trusted (offline/degraded/unconfigured/stale) — see that
      // function's own doc comment.
      const resolved = resolveNodeCapacity(node);
      const acceptance = nodeAcceptsNewServers({
        capacityMode: node.capacityMode,
        maintenanceMode: node.maintenanceMode,
        health: deriveHealthStatus(node.lastHeartbeatAt),
        memory: resolved.memory,
        disk: resolved.disk,
        telemetryStale: resolved.telemetryStale,
      });
      if (!acceptance.ok) throw new ConflictException(acceptance.reason);

      const usage = await this.capacity.usageForNode(tx, nodeId);
      assertNodeFits(resolved, usage, { memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuPercent: plan.cpuLimitPercent });

      const allocation = dto.allocationId
        ? await tx.allocation.findFirst({ where: { id: BigInt(dto.allocationId), nodeId, serverId: null } })
        : await this.capacity.pickFreeAllocation(tx, nodeId);
      if (!allocation) {
        throw new ConflictException(
          dto.allocationId ? 'Requested allocation is not free' : 'No free allocation available on this node',
        );
      }

      const uid = await this.capacity.nextUid(tx, nodeId);
      const shortId = await generateUniqueShortId(tx);

      const server = await tx.server.create({
        data: {
          shortId,
          ownerId: dto.ownerId,
          nodeId,
          templateId: templateContext?.template.id ?? null,
          planId: dto.planId,
          uid,
          // A post-purchase reservation has no customer-chosen name yet
          // (that's the whole point of `setup_pending`) — `shortId` is
          // already unique and human-legible enough to stand in until
          // ServerSetupService.complete overwrites it for real.
          name: dto.name ?? `Servidor ${shortId}`,
          dockerImage: templateContext?.dockerImage ?? null,
          startupCommand: templateContext?.template.startupCommand ?? null,
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
          status: templateContext ? 'installing' : 'setup_pending',
        },
      });

      await tx.allocation.update({ where: { id: allocation.id }, data: { serverId: server.id, isPrimary: true } });

      if (dto.attachSubscriptionId) {
        // Scoped to `userId: dto.ownerId` — attaching a server to a
        // subscription belonging to someone ELSE would silently hand
        // one customer's paid slot to another customer's server.
        const subscription = await tx.subscription.findFirst({ where: { id: dto.attachSubscriptionId, userId: dto.ownerId } });
        if (!subscription) throw new NotFoundException('Subscription not found for attach');
        // Compare-and-swap, not a plain update: a bare SELECT-then-UPDATE
        // has a real race window inside READ COMMITTED (nothing above
        // takes a row lock on `subscription`), and the UNIQUE index on
        // `subscriptions.server_id` does NOT protect this direction — it
        // stops two subscriptions pointing at the same server, not the
        // same subscription being re-pointed at a second one. The
        // `serverId: null` guard in the WHERE clause is re-evaluated at
        // UPDATE time under the row lock the UPDATE itself takes, so of
        // two concurrent attaches exactly one gets `count === 1`.
        const attach = await tx.subscription.updateMany({
          where: { id: subscription.id, serverId: null },
          data: { serverId: server.id },
        });
        if (attach.count === 0) {
          throw new ConflictException('SUBSCRIPTION_ALREADY_HAS_SERVER: this subscription is already attached to a server');
        }
      }

      if (!templateContext) {
        return { server, uid, allocation, declaredNames: [] as string[], resolvedValues: {} as Record<string, string> };
      }

      const templateVars = await tx.templateVariable.findMany({ where: { templateId: templateContext.template.id } });
      const declaredNames = templateVars.map((v) => v.envVariable);
      const requested = dto.variables ?? {};

      // Mirrors ServerVariablesService.update's own enforcement exactly
      // (variable-rules.ts's `validateVariableValue` + `isUserEditable`) —
      // until now `requested` was written verbatim with no check at all,
      // harmless while only an admin could reach this path but a real hole
      // the moment customer input (checkout server config) starts flowing
      // in here. Unknown keys are left alone (silently unused below, same
      // as before) rather than rejected — this method also serves
      // admin-driven creation, which may pass through incidental extra
      // fields no template declares.
      const byEnvVar = new Map(templateVars.map((tv) => [tv.envVariable, tv]));
      for (const [key, value] of Object.entries(requested)) {
        const tv = byEnvVar.get(key);
        if (!tv) continue;
        if (!tv.isUserEditable) throw new ForbiddenException(`Variável não editável: ${key}`);
        const error = validateVariableValue(value, tv.rules);
        if (error) throw new BadRequestException(`${tv.name}: ${error}`);
      }

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
      metadata: {
        ownerId: dto.ownerId,
        nodeId,
        templateId: templateContext?.template.id ?? null,
        planId: dto.planId,
        // Only present for automatic selection — an explicit `nodeId`
        // never invokes the scheduler at all. This is the only place
        // that will still explain "why is this customer on NODE 02" six
        // months from now.
        ...(schedulerCandidates ? { scheduler: schedulerCandidates } : {}),
      },
    });

    // Public-exposure plan: the allocation is already reserved at this
    // point regardless of templateContext, so the public port is too —
    // a 'setup_pending' server gets its public endpoint immediately,
    // the same way it already gets its internal ip:port immediately.
    // Best-effort, never throws (see GatewayService's own doc comment):
    // a misconfigured/offline gateway must never fail a server create.
    await this.gateway.ensureRouteForServer(created.server.id);

    if (!templateContext) {
      // No template chosen yet — nothing to dispatch. This is the entire
      // reason CPU/RAM stay at zero for a 'setup_pending' server: the
      // agent never hears about it until ServerSetupService.complete.
      return { id: created.server.id, shortId: created.server.shortId, status: created.server.status };
    }

    await this.dispatchToAgent(created.server.id, nodeId, {
      uuid: created.server.id,
      uid: created.uid,
      image: templateContext.dockerImage,
      startupTemplate: templateContext.template.startupCommand,
      stopSignal: undefined,
      declaredVariables: created.declaredNames,
      variables: created.resolvedValues,
      limits: {
        cpuPercent: created.server.cpuLimitPercent,
        memoryMb: created.server.memoryMb,
        swapMb: created.server.swapMb,
        diskMb: created.server.diskMb,
        ioWeight: created.server.ioWeight,
      },
      allocations: [{ ip: created.allocation.ip, port: created.allocation.port, primary: true }],
      installImage: templateContext.template.installImage || DEFAULT_INSTALL_IMAGE,
      installEntrypoint: templateContext.template.installEntrypoint || DEFAULT_INSTALL_ENTRYPOINT,
      installScript: templateContext.template.installScript,
    });

    return { id: created.server.id, shortId: created.server.shortId, status: created.server.status };
  }

  /**
   * Public (not just for `createOnNode`) so `ServerSetupService.complete`
   * — the post-purchase setup/retry path — dispatches through the exact
   * same failure handling, rather than reimplementing it.
   *
   * `options.rethrow`: `createOnNode`'s admin/legacy callers have never
   * seen a dispatch failure as an HTTP error — they always got their
   * 200/201 back with a server that then silently showed
   * `install_failed`, and that behavior is preserved by leaving this
   * `false` by default. `ServerSetupService.complete` passes `true`: the
   * customer's "Tentar novamente" needs a REAL error, not a false
   * success, per the retry requirement (see that service's own doc
   * comment).
   */
  async dispatchToAgent(
    serverId: string,
    nodeId: string,
    payload: CreateAgentServerRequest,
    options?: { rethrow?: boolean },
  ): Promise<void> {
    try {
      await this.agent.createServer(nodeId, payload);
    } catch (err) {
      let failure = err;

      // A 409 `SERVER_EXISTS` means the agent's in-memory Register guard
      // (agent/internal/srv/manager.go) already holds this UUID, so
      // `createServer` can never succeed for it again.
      //
      // This used to return here, treating the 409 as success and
      // trusting the agent's install-completed callback to reconcile the
      // row. That assumed the 409 meant "an earlier call is already
      // installing" — true for a duplicated request in flight, false for
      // a setup RETRY minutes or hours later, which is the common case.
      // The agent's 409 path returns before pulling, creating or
      // installing anything, so no callback was ever coming: found live
      // with a server that sat on "Preparando" for twelve hours after two
      // retries, both audited as dispatch_already_registered.
      //
      // Reinstall is precisely "re-run the install on a server the agent
      // already has registered" — it recreates the container and drives
      // the same install-completed callback — so a create that lands on
      // an already-registered UUID is re-driven through it.
      if (err instanceof ConflictException && err.message.includes('SERVER_EXISTS')) {
        try {
          await this.agent.reinstallServer(nodeId, serverId, {
            image: payload.image,
            imageDigest: payload.imageDigest,
            startupTemplate: payload.startupTemplate,
            stopSignal: payload.stopSignal,
            declaredVariables: payload.declaredVariables,
            variables: payload.variables,
            installImage: payload.installImage,
            installEntrypoint: payload.installEntrypoint,
            installScript: payload.installScript,
          });
          await this.audit.record({
            action: 'server.create.dispatch_rerouted_to_reinstall',
            targetType: 'server',
            targetId: serverId,
            metadata: {},
          });
          return;
        } catch (reinstallErr) {
          // Falls through to the same install_failed handling below: a
          // server the agent knows but cannot reinstall is a real
          // failure the customer has to see, not another silent wait.
          failure = reinstallErr;
        }
      }

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
        metadata: { error: (failure as Error).message },
      });
      if (options?.rethrow) throw failure;
    }
  }

  /**
   * The reinstall counterpart to dispatchToAgent, for
   * ServerSetupService.changeVersion. Deliberately NOT a call to
   * dispatchToAgent/agent.createServer: a version change only ever runs
   * on a `ready` server, which by construction already has a container
   * the agent registered during its ORIGINAL create — `agent.createServer`
   * would hit manager.Register's guard and always come back 409
   * SERVER_EXISTS. Found live: that is exactly what changeVersion did
   * before this method existed, and dispatchToAgent's own SERVER_EXISTS
   * branch (correctly, for the create-retry case it exists for) swallows
   * that 409 as success and leaves the row at `installing` — with no
   * container ever touched and no install ever run, nothing was ever
   * going to call reportInstallResult back, so the row was stuck forever.
   *
   * On a genuine dispatch failure here, `previous` (the server's
   * template/image/startup command from BEFORE changeVersion's own CAS
   * overwrote them) is restored alongside `status: 'ready'`, not
   * `install_failed`: unlike a brand-new server (dispatchToAgent's case,
   * where there is no earlier working state to fall back to), a failed
   * reinstall dispatch leaves the OLD container exactly as it was — the
   * agent only ever removes it AFTER a successful image pull, inside the
   * same call this method is reacting to failing. Reporting `ready` with
   * the old software is what actually matches reality; `install_failed`
   * would tell the customer their previously-working server is now
   * broken when it never stopped working at all.
   */
  async dispatchReinstallToAgent(
    serverId: string,
    nodeId: string,
    payload: ReinstallAgentServerRequest,
    previous: { templateId: string; dockerImage: string; startupCommand: string },
    options?: { rethrow?: boolean },
  ): Promise<void> {
    try {
      await this.agent.reinstallServer(nodeId, serverId, payload);
    } catch (err) {
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.server.update({
          where: { id: serverId },
          data: { status: 'ready', templateId: previous.templateId, dockerImage: previous.dockerImage, startupCommand: previous.startupCommand },
        }),
      );
      await this.audit.record({
        action: 'server.reinstall.dispatch_failed',
        targetType: 'server',
        targetId: serverId,
        metadata: { error: (err as Error).message, revertedToTemplateId: previous.templateId },
      });
      if (options?.rethrow) throw err;
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

    // Public-exposure plan: a pure DB marker for observability only —
    // public_routes.server_id cascades on server.delete below regardless
    // of this call's outcome, see GatewayService.markRemoving's own doc
    // comment for why that's sufficient (the next periodic reconcile
    // closes the port on the gateway side).
    await this.gateway.markRemoving(server.id);

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
   * which is exactly what lets the payments webhook and billing-cycle
   * job call this without first checking current state — a retried
   * webhook delivery for an already-suspended server just re-writes the
   * same row.
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
   * an automated billing-driven suspend doesn't — no human initiated
   * that, and `audit_logs.actor_id` is a real FK to `users`, so passing
   * anything other than a genuine user id or null would fail at the
   * database (a placeholder string like `"billing-webhook"` isn't a
   * valid uuid). The audit row itself still fully identifies a
   * billing-driven suspension via `action` ('admin.server.suspend') and
   * `metadata.reason`/`source` — a null actor reads as "the system did
   * this," not "we lost track of who."
   */
  /**
   * `source` ('admin' by default, 'billing' for the billing-cycle job /
   * payments webhook) is written to `suspensionSource` — the only thing
   * that lets `unsuspend`'s `requireSource` guard refuse to lift a
   * suspension it didn't create. Before this column existed, `unsuspend`
   * was unconditional: any caller (including an automated payment
   * confirmation) could reactivate a server an admin suspended for
   * abuse. See that guard's own doc comment.
   */
  async suspend(id: string, reason: string, actorId: string | null, source: 'admin' | 'billing' = 'admin'): Promise<void> {
    const server = await this.get(id);
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.update({ where: { id }, data: { status: 'suspended', suspendedAt: new Date(), suspensionReason: reason, suspensionSource: source } }),
    );
    await this.audit.record({ action: 'admin.server.suspend', actorId, targetType: 'server', targetId: id, metadata: { reason, source } });
    await this.agent.setSuspended(server.node.id, id, true).catch((err) => {
      void this.audit.record({ action: 'admin.server.suspend.agent_push_failed', actorId, targetType: 'server', targetId: id, metadata: { error: (err as Error).message } });
    });
  }

  /**
   * `requireSource`: when set, refuses (returns `false`, no-op — never
   * throws, since an automated caller iterating many servers must not
   * have one mismatch abort the whole batch) unless the server's
   * CURRENT `suspensionSource` matches. This is what stops a recovered
   * payment from undoing an admin's abuse suspension: billing-cycle and
   * the payments webhook always pass `requireSource: 'billing'`; a human
   * admin unsuspending via the controller passes nothing and can lift
   * any suspension, same as before this guard existed.
   */
  async unsuspend(id: string, actorId: string | null, options?: { requireSource?: 'admin' | 'billing' }): Promise<boolean> {
    const server = await this.get(id);
    if (options?.requireSource && server.suspensionSource !== options.requireSource) {
      return false;
    }
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.update({ where: { id }, data: { status: 'ready', suspendedAt: null, suspensionReason: null, suspensionSource: null } }),
    );
    await this.audit.record({ action: 'admin.server.unsuspend', actorId, targetType: 'server', targetId: id });
    await this.agent.setSuspended(server.node.id, id, false).catch((err) => {
      void this.audit.record({ action: 'admin.server.unsuspend.agent_push_failed', actorId, targetType: 'server', targetId: id, metadata: { error: (err as Error).message } });
    });
    return true;
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

// assertCapacity and pickFreeAllocation moved to
// ../capacity/capacity.math.ts and ../capacity/capacity.service.ts
// (capacity plan Fase 1) — CapacityService.usageForNode/assertNodeFits/
// pickFreeAllocation/nextUid are the shared building blocks now, used
// identically by this file and transfers.service.ts.

async function generateUniqueShortId(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShortId();
    const existing = await tx.server.findFirst({ where: { shortId: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new ConflictException('Could not allocate a unique short_id, please retry');
}
