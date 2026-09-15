import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Gateway } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GATEWAY_DRIVER, type DesiredRoute, type GatewayDriver } from './gateway-driver.interface';
import { DNS_PROVIDER, type DnsProvider } from './dns/dns-provider.interface';
import { deriveHostname } from './public-address';
import type { CreateGatewayDto, UpdateGatewayDto } from './dto/gateway.dto';

const PORT_CREATE_ATTEMPTS = 50;

/**
 * Public-exposure plan — the desired-state half of the gateway feature.
 * `ensureRouteForServer`/`markRemoving` are the ONLY two entry points the
 * rest of the app (ServersService, TransfersService) ever calls, and both
 * are deliberately fire-and-forget: they touch nothing but this module's
 * own two tables and never throw past their own boundary — a gateway
 * that's misconfigured or offline must never fail a server create,
 * delete, or transfer (public-exposure plan §11). All the actual network
 * I/O with a gateway (`GatewayDriver.apply`) happens in `reconcileOnce`,
 * called on a timer by `GatewayReconcileProcessor` — never inline here.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Inject(GATEWAY_DRIVER) private readonly driver: GatewayDriver,
    @Inject(DNS_PROVIDER) private readonly dns: DnsProvider,
  ) {}

  private asAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  // ---- admin CRUD (Gateway rows) ----

  listGateways() {
    return this.asAdmin((tx) => tx.gateway.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }));
  }

  async createGateway(dto: CreateGatewayDto, actorId: string) {
    const created = await this.asAdmin((tx) =>
      tx.gateway.create({
        data: { name: dto.name, publicHost: dto.publicHost, tunnelIp: dto.tunnelIp, controlUrl: dto.controlUrl },
      }),
    );
    await this.audit.record({ action: 'admin.gateway.create', actorId, targetType: 'gateway', targetId: created.id, metadata: { name: created.name } });
    return created;
  }

  async updateGateway(id: string, dto: UpdateGatewayDto, actorId: string) {
    await this.getGatewayOrThrow(id);
    const updated = await this.asAdmin((tx) =>
      tx.gateway.update({
        where: { id },
        data: {
          name: dto.name,
          publicHost: dto.publicHost,
          tunnelIp: dto.tunnelIp,
          controlUrl: dto.controlUrl,
          isActive: dto.isActive,
        },
      }),
    );
    await this.audit.record({ action: 'admin.gateway.update', actorId, targetType: 'gateway', targetId: id });
    return updated;
  }

  /**
   * Soft-delete only, same posture as every other infrastructure row in
   * this codebase (Node, Location). Deliberately does NOT touch existing
   * `PublicRoute` rows pointing at this gateway — `reconcileOnce` already
   * only ever processes `isActive: true, deletedAt: null` gateways, so
   * they simply stop being reconciled (and, on the driver side, stop
   * being served the moment the gateway process itself is decommissioned
   * — a DB-level delete here can't un-expose a port by itself anyway).
   */
  async removeGateway(id: string, actorId: string): Promise<void> {
    await this.getGatewayOrThrow(id);
    await this.asAdmin((tx) => tx.gateway.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } }));
    await this.audit.record({ action: 'admin.gateway.delete', actorId, targetType: 'gateway', targetId: id });
  }

  private async getGatewayOrThrow(id: string): Promise<Gateway> {
    const gateway = await this.asAdmin((tx) => tx.gateway.findFirst({ where: { id, deletedAt: null } }));
    if (!gateway) throw new NotFoundException('Gateway not found');
    return gateway;
  }

  // ---- hooks called from ServersService / TransfersService ----

  /**
   * Called after `ServersService.createOnNode`'s transaction commits.
   * No-ops (never throws) when: no active gateway is configured (the
   * feature is simply off), or a route for this server already exists
   * (idempotent — a retried dispatch, or `ServerSetupService.complete`
   * calling this a second time for the same server, must never create a
   * duplicate route or a second gateway.route.created audit entry).
   */
  async ensureRouteForServer(serverId: string): Promise<void> {
    try {
      const gateway = await this.asAdmin((tx) => tx.gateway.findFirst({ where: { isActive: true, deletedAt: null }, orderBy: { createdAt: 'asc' } }));
      if (!gateway) return; // feature not configured — today's behavior, unchanged

      const existing = await this.asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }));
      if (existing) return;

      const allocation = await this.asAdmin((tx) =>
        tx.allocation.findFirst({ where: { serverId, isPrimary: true }, select: { port: true } }),
      );
      if (!allocation) {
        this.logger.warn(`ensureRouteForServer: server ${serverId} has no primary allocation yet, skipping`);
        return;
      }

      const route = await this.createRouteWithFreePort(gateway.id, serverId, allocation.port);
      await this.audit.record({
        action: 'gateway.route.created',
        targetType: 'server',
        targetId: serverId,
        metadata: { gatewayId: gateway.id, publicPort: route.publicPort },
      });
      this.enqueueReconcileBestEffort();
    } catch (err) {
      // Never propagate — see class doc comment. A server that fails to
      // get a public route stays perfectly usable internally; the next
      // periodic reconcile (or a retried setup/create) tries again.
      this.logger.error(`ensureRouteForServer failed for server ${serverId}: ${(err as Error).message}`);
    }
  }

  /**
   * Tries the server's own internal port first (keeps public == internal
   * port in the common case, which is easier for a human to read in the
   * admin UI), then walks `PUBLIC_GATEWAY_PORT_RANGE` on collision. The
   * `@@unique([gatewayId, publicPort])` constraint is the actual race
   * backstop — this loop is just how a caller recovers from hitting it,
   * the same shape `generateUniqueShortId` already uses for shortId
   * collisions.
   */
  private async createRouteWithFreePort(gatewayId: string, serverId: string, preferredPort: number) {
    const [rangeStart, rangeEnd] = this.portRange();
    const candidates: number[] = [];
    if (preferredPort >= rangeStart && preferredPort <= rangeEnd) candidates.push(preferredPort);
    for (let port = rangeStart; port <= rangeEnd && candidates.length < PORT_CREATE_ATTEMPTS; port++) {
      if (port !== preferredPort) candidates.push(port);
    }

    for (const publicPort of candidates.slice(0, PORT_CREATE_ATTEMPTS)) {
      try {
        return await this.asAdmin((tx) => tx.publicRoute.create({ data: { gatewayId, serverId, publicPort, protocol: 'tcp', state: 'pending' } }));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new ConflictException(`No free public port for gateway ${gatewayId} in range ${rangeStart}-${rangeEnd}`);
  }

  private portRange(): [number, number] {
    const raw = this.config.get<string>('PUBLIC_GATEWAY_PORT_RANGE') ?? '25565-25664';
    const [start, end] = raw.split('-').map((n) => parseInt(n, 10));
    return [start, end];
  }

  /**
   * Called from `ServersService.remove()`, right before the transaction
   * that hard-deletes the server row. Purely a DB marker for
   * observability (a row briefly visible as `removing` in an audit/admin
   * view) — the actual removal from the gateway's config doesn't depend
   * on this: `public_routes.server_id` has `ON DELETE CASCADE`, so the
   * row disappears the instant the server does regardless of what this
   * method does, and the NEXT periodic reconcile naturally renders a
   * smaller desired set and closes the port. Never throws.
   */
  async markRemoving(serverId: string): Promise<void> {
    try {
      await this.asAdmin((tx) => tx.publicRoute.updateMany({ where: { serverId }, data: { state: 'removing' } }));
    } catch (err) {
      this.logger.error(`markRemoving failed for server ${serverId}: ${(err as Error).message}`);
    }
  }

  /**
   * Called after `TransfersService.handleResult`'s success transaction —
   * a transfer flips `server.nodeId` and swaps which `Allocation` is
   * primary, which changes this route's TARGET but never its public
   * port or its row's existence. Nothing to write here: `reconcileOnce`
   * re-derives the target (node.tunnelIp + current primary allocation)
   * fresh on every run, so the existing `PublicRoute` row self-corrects
   * on the next tick. This just asks for that tick sooner than the
   * periodic timer would.
   */
  requestReconcileForTransfer(): void {
    this.enqueueReconcileBestEffort();
  }

  private reconcileRequested: (() => void) | null = null;

  /** Wired by `GatewayQueueService` at module init — kept as a plain callback (not a DI cycle) so this service has zero BullMQ/Redis knowledge of its own. */
  setReconcileRequester(fn: () => void): void {
    this.reconcileRequested = fn;
  }

  private enqueueReconcileBestEffort(): void {
    try {
      this.reconcileRequested?.();
    } catch (err) {
      this.logger.error(`failed to enqueue reconcile: ${(err as Error).message}`);
    }
  }

  // ---- reconciliation (called by GatewayReconcileProcessor) ----

  /**
   * The reconciliation loop (public-exposure plan §12): recomputes the
   * FULL desired route set per gateway from current DB state and pushes
   * it via `GatewayDriver.apply`, which itself replaces the gateway's
   * entire configuration rather than diffing — so running this twice in
   * a row, or after a gateway lost its config entirely, converges to the
   * same result either way. Never touches `Server`/`Allocation` — a
   * gateway failure only ever changes `PublicRoute.state`/`lastError`.
   */
  async reconcileOnce(): Promise<void> {
    const gateways = await this.asAdmin((tx) => tx.gateway.findMany({ where: { isActive: true, deletedAt: null } }));
    for (const gateway of gateways) {
      await this.reconcileGateway(gateway);
    }
  }

  private async reconcileGateway(gateway: Gateway): Promise<void> {
    const routes = await this.asAdmin((tx) =>
      tx.publicRoute.findMany({
        where: { gatewayId: gateway.id },
        include: {
          server: {
            select: {
              id: true,
              shortId: true,
              node: { select: { tunnelIp: true } },
              allocations: { where: { isPrimary: true }, select: { port: true }, take: 1 },
            },
          },
        },
      }),
    );

    const removingIds: string[] = [];
    const includedIds: string[] = [];
    const skippedIds: string[] = [];
    const desired: DesiredRoute[] = [];

    for (const route of routes) {
      if (route.state === 'removing') {
        removingIds.push(route.id);
        continue;
      }
      const tunnelIp = route.server.node.tunnelIp;
      const allocation = route.server.allocations[0];
      if (!tunnelIp || !allocation) {
        skippedIds.push(route.id);
        continue;
      }
      desired.push({ serverId: route.serverId, publicPort: route.publicPort, protocol: 'tcp', targetIp: tunnelIp, targetPort: allocation.port });
      includedIds.push(route.id);
    }

    if (includedIds.length === 0 && removingIds.length === 0 && skippedIds.length === 0) return;

    try {
      await this.driver.apply(gateway, desired);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`reconcile failed for gateway ${gateway.name}: ${message}`);
      await this.asAdmin(async (tx) => {
        if (includedIds.length) await tx.publicRoute.updateMany({ where: { id: { in: includedIds } }, data: { state: 'failed', lastError: message } });
        await tx.gateway.update({ where: { id: gateway.id }, data: { lastError: message } });
      });
      return;
    }

    await this.asAdmin(async (tx) => {
      if (includedIds.length) {
        await tx.publicRoute.updateMany({ where: { id: { in: includedIds } }, data: { state: 'active', appliedAt: new Date(), lastError: null } });
      }
      if (skippedIds.length) {
        await tx.publicRoute.updateMany({
          where: { id: { in: skippedIds } },
          data: { state: 'failed', lastError: 'node has no tunnel IP configured, or server has no primary allocation yet' },
        });
      }
      if (removingIds.length) {
        await tx.publicRoute.deleteMany({ where: { id: { in: removingIds } } });
      }
      await tx.gateway.update({ where: { id: gateway.id }, data: { lastAppliedAt: new Date(), lastError: null } });
    });

    await this.syncDns(gateway, routes, includedIds);
  }

  /** Best-effort SRV sync — see DnsProvider's own doc comment. Never allowed to affect a route's state; a customer can always fall back to `host:port`. */
  private async syncDns(gateway: Gateway, routes: { id: string; publicPort: number; server: { shortId: string } }[], includedIds: string[]): Promise<void> {
    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    if (!zone) return;
    for (const route of routes) {
      if (!includedIds.includes(route.id)) continue;
      const hostname = deriveHostname(route.server.shortId, zone);
      try {
        await this.dns.ensureSrv({ hostname, target: gateway.publicHost, port: route.publicPort });
      } catch (err) {
        this.logger.error(`SRV sync failed for ${hostname}: ${(err as Error).message}`);
      }
    }
  }
}
