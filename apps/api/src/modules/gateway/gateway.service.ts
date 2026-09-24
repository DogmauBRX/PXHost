import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Gateway, type PublicRoute } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GATEWAY_DRIVER, type DesiredRoute, type GatewayDriver } from './gateway-driver.interface';
import { DNS_PROVIDER, type DnsProvider } from './dns/dns-provider.interface';
import { deriveCustomHostname, deriveHostname } from './public-address';
import type { CreateGatewayDto, UpdateGatewayDto } from './dto/gateway.dto';

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
   * admin UI), then walks the complete `PUBLIC_GATEWAY_PORT_RANGE` on collision. The
   * `@@unique([gatewayId, publicPort])` constraint is the actual race
   * backstop — this loop is just how a caller recovers from hitting it,
   * the same shape `generateUniqueShortId` already uses for shortId
   * collisions.
   */
  private async createRouteWithFreePort(gatewayId: string, serverId: string, preferredPort: number) {
    const [rangeStart, rangeEnd] = this.portRange();
    const candidates: number[] = [];
    if (preferredPort >= rangeStart && preferredPort <= rangeEnd) candidates.push(preferredPort);
    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (port !== preferredPort) candidates.push(port);
    }

    for (const publicPort of candidates) {
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
   * that hard-deletes the server row. The gateway-config removal doesn't
   * depend on this — `public_routes.server_id` has `ON DELETE CASCADE`,
   * so the row disappears the instant the server does, and the NEXT
   * periodic reconcile naturally renders a smaller desired set and
   * closes the port — but DNS cleanup DOES depend on this being here:
   * the row (and its `dnsSyncedHostname`) is gone by the time any
   * reconcile could ever observe `state: 'removing'`, since this method
   * runs synchronously one line before the hard-delete in the same
   * request. This is the one real place a custom or derived hostname's
   * SRV/A/AAAA records actually get torn down — found live 2026-09-15
   * as a pre-existing gap (deleting a server never removed its SRV
   * record at all). Never throws.
   */
  async markRemoving(serverId: string): Promise<void> {
    try {
      const route = await this.asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }));
      if (!route) return;
      await this.asAdmin((tx) => tx.publicRoute.update({ where: { serverId }, data: { state: 'removing' } }));
      if (route.dnsSyncedHostname) await this.removeDnsFor(route.dnsSyncedHostname);
    } catch (err) {
      this.logger.error(`markRemoving failed for server ${serverId}: ${(err as Error).message}`);
    }
  }

  /**
   * Custom-hostname plan — the customer-facing entry point (called by
   * ServerHostnameService). `label === null` clears the reservation.
   * Requires a `PublicRoute` to already exist (created by
   * `ensureRouteForServer` at server-create time) — there's nothing to
   * attach a hostname to otherwise. Unlike `ensureRouteForServer`/
   * `markRemoving`, this DOES throw — it's a direct customer action, not
   * a fire-and-forget infra hook, so the caller needs a real error to
   * show.
   */
  async setCustomHostname(serverId: string, label: string | null): Promise<PublicRoute> {
    const route = await this.asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }));
    if (!route) throw new ConflictException('Este servidor ainda não tem uma exposição pública configurada');

    if (label === null) {
      const updated = await this.asAdmin((tx) => tx.publicRoute.update({ where: { serverId }, data: { customHostname: null } }));
      this.enqueueReconcileBestEffort();
      return updated;
    }

    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    if (!zone) throw new ConflictException('Hostname personalizado requer um domínio configurado nesta instalação');

    const fqdn = deriveCustomHostname(label, zone);

    // Refused here, not swallowed by the reconciler later. A name the
    // provider cannot publish will never resolve no matter how many
    // times the 30s pass retries, so accepting the save would hand the
    // customer an address that looks official in the panel and simply
    // does not work — which is exactly what happened before this check
    // existed. Unlike isHostnameAvailable below, this one is about
    // configuration, so it does NOT fail open.
    if (!this.dns.canPublish(fqdn)) {
      this.logger.error(`refusing custom hostname ${fqdn}: the DNS provider cannot publish in that zone`);
      throw new ConflictException('Este endereço não pode ser publicado pela configuração de DNS desta instalação');
    }

    try {
      const available = await this.dns.isHostnameAvailable(fqdn);
      if (!available) throw new ConflictException('Este endereço já está em uso');
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // Live-check failure (network/API) fails OPEN — an unrelated DNS
      // provider outage must never block a customer's save. The
      // reserved-word list (checked by the caller) plus the DB's own
      // unique constraint below are the real backstops.
      this.logger.warn(`isHostnameAvailable failed for ${fqdn}, failing open: ${(err as Error).message}`);
    }

    try {
      const updated = await this.asAdmin((tx) => tx.publicRoute.update({ where: { serverId }, data: { customHostname: label } }));
      this.enqueueReconcileBestEffort();
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Este endereço já está em uso por outro servidor');
      }
      throw err;
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

    await this.syncDns(gateway, routes, includedIds, removingIds);
  }

  /**
   * DNS sync — best-effort, never allowed to affect a route's `state`
   * (a customer can always fall back to `host:port`). Prefers
   * `customHostname` (custom-hostname plan) over the shortId-derived
   * `.mc.` scheme when set. Tracks `dnsSyncedHostname` per route so a
   * RENAME (or a hostname being cleared) removes the OLD record instead
   * of leaking it — `ensureSrv`/`ensureAddressRecord` alone would only
   * ever create/update the NEW name, never clean up a name that's no
   * longer desired. `removingIds` routes are already hard-deleted from
   * the DB by the time this runs (see `reconcileGateway` above) — this
   * loop still visits them, using the in-memory `routes` snapshot taken
   * before the delete, as defense-in-depth for any future caller that
   * sets `state: 'removing'` without also calling `markRemoving` (which
   * is where this actually gets cleaned up today, synchronously, before
   * the row disappears).
   */
  private async syncDns(
    gateway: Gateway,
    routes: (Pick<PublicRoute, 'id' | 'publicPort' | 'customHostname' | 'dnsSyncedHostname'> & { server: { shortId: string } })[],
    includedIds: string[],
    removingIds: string[],
  ): Promise<void> {
    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    const byId = new Map(routes.map((r) => [r.id, r]));

    for (const id of [...includedIds, ...removingIds]) {
      const route = byId.get(id);
      if (!route) continue;
      const included = includedIds.includes(id);

      if (!zone && !route.dnsSyncedHostname) continue; // never synced, nothing configured — nothing to do

      const desiredHostname = included
        ? route.customHostname
          ? deriveCustomHostname(route.customHostname, zone ?? '')
          : zone
            ? deriveHostname(route.server.shortId, zone)
            : null
        : null;

      if (desiredHostname === route.dnsSyncedHostname) {
        if (included && desiredHostname) await this.ensureDnsFor(desiredHostname, gateway.publicHost, route.publicPort);
        continue;
      }

      // Row already hard-deleted — the old name is all there is to clean
      // up, and nothing will be published in its place.
      if (!included) {
        if (route.dnsSyncedHostname) await this.removeDnsFor(route.dnsSyncedHostname);
        continue;
      }

      // Target changed (rename, cleared, or newly set). PUBLISH FIRST,
      // retire the old name only once the new one is actually answering.
      //
      // This used to remove the old record up front, so that a rename
      // could never leave the previous name resolving. That reasoning
      // only holds when the new record is certain to land — and it is
      // not: `ensureDnsFor` returns false whenever the provider refuses
      // the name. Found live: a customer set a custom hostname the
      // PowerDNS zone cannot hold, and the sync deleted the working
      // `<shortId>.mc.<zone>` record before discovering it could not
      // publish the replacement. The server was left with NO address at
      // all, the route still marked `active`, and the panel still
      // showing the new name as if it worked.
      //
      // A rename that leaks the old name for one reconcile pass is a
      // cosmetic problem, self-correcting 30 seconds later. A rename
      // that takes a live server off DNS is an outage. The order now
      // reflects that difference.
      let newSynced: string | null = null;
      if (desiredHostname) {
        const ok = await this.ensureDnsFor(desiredHostname, gateway.publicHost, route.publicPort);
        if (ok) newSynced = desiredHostname;
      }

      // Nothing new to point at (publish failed) means the old name is
      // the only address this server still has — keep it, and try again
      // on the next pass. Only a deliberate clear (no desired hostname)
      // retires it unconditionally.
      if (route.dnsSyncedHostname && route.dnsSyncedHostname !== newSynced && (newSynced || !desiredHostname)) {
        await this.removeDnsFor(route.dnsSyncedHostname);
      }
      if (!newSynced && desiredHostname && route.dnsSyncedHostname) {
        this.logger.warn(
          `keeping ${route.dnsSyncedHostname} published for route ${route.id}: ${desiredHostname} could not be published`,
        );
        newSynced = route.dnsSyncedHostname;
      }

      try {
        await this.asAdmin((tx) => tx.publicRoute.update({ where: { id: route.id }, data: { dnsSyncedHostname: newSynced } }));
      } catch (err) {
        this.logger.error(`failed to persist dnsSyncedHostname for route ${route.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Address record FIRST, then SRV — not just ordering for its own sake.
   * An SRV record's `target` must itself be a hostname per the DNS spec
   * (a real provider enforces this: a literal IP there fails outright with
   * "SRV target must be a hostname", found live — every route on a
   * fresh gateway retried and failed this every ~30s, forever, and a
   * bare `return false` in the old SRV-first ordering meant the address
   * record was never even attempted either, so NEITHER record ever
   * existed for a customer to fall back to). `target: hostname` — the
   * SAME hostname this method's own address record points at the
   * gateway's IP — is what makes it a valid, resolvable target instead
   * of a raw address. SRV is still the functionally required record
   * (it's what makes "no port" work); an address-record failure is
   * logged but doesn't stop SRV from being attempted. Returns whether
   * SRV succeeded.
   */
  private async ensureDnsFor(hostname: string, gatewayPublicHost: string, port: number): Promise<boolean> {
    try {
      await this.dns.ensureAddressRecord({ hostname, ip: gatewayPublicHost });
    } catch (err) {
      this.logger.error(`address record sync failed for ${hostname}: ${(err as Error).message}`);
    }
    try {
      await this.dns.ensureSrv({ hostname, target: hostname, port });
    } catch (err) {
      this.logger.error(`SRV sync failed for ${hostname}: ${(err as Error).message}`);
      return false;
    }
    return true;
  }

  private async removeDnsFor(hostname: string): Promise<void> {
    try {
      await this.dns.removeSrv(hostname);
    } catch (err) {
      this.logger.error(`removeSrv failed for ${hostname}: ${(err as Error).message}`);
    }
    try {
      await this.dns.removeAddressRecord(hostname);
    } catch (err) {
      this.logger.error(`removeAddressRecord failed for ${hostname}: ${(err as Error).message}`);
    }
  }
}
