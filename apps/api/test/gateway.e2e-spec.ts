import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { GATEWAY_DRIVER, type DesiredRoute, type GatewayDriver } from '../src/modules/gateway/gateway-driver.interface';
import { DNS_PROVIDER, type AddressRecordInput, type DnsProvider, type SrvRecordInput } from '../src/modules/gateway/dns/dns-provider.interface';
import { GatewayService } from '../src/modules/gateway/gateway.service';

// Custom-hostname plan's e2e tests need PUBLIC_GATEWAY_HOSTNAME_ZONE
// configured (local dev's .env has no PUBLIC_GATEWAY_* vars at all —
// this whole feature has only ever been exercised via ad-hoc DB rows in
// this file). Set BEFORE the testing module compiles: @nestjs/config's
// ConfigModule.forRoot() merges dotenv into process.env WITHOUT
// overriding a key that's already set, so this value wins over the
// (absent) .env entry. Each Jest test FILE runs in its own worker/module
// registry, so this never leaks into other spec files.
process.env.PUBLIC_GATEWAY_HOSTNAME_ZONE = 'gw-e2e-test.local';

/**
 * Public-exposure plan — end-to-end proof that the gateway layer sits
 * ENTIRELY on top of the existing create/remove/allocation machinery:
 * every assertion here about a server's own row (status, allocation,
 * capacity) should read exactly like servers.e2e-spec.ts's, because
 * nothing in this feature is allowed to change that behavior. A
 * `FakeGatewayDriver` stands in for the real HTTP call to apps/gateway
 * (same "inject a fake at the one seam" pattern FakePaymentProvider
 * already establishes for PAYMENT_PROVIDER) — this suite proves the
 * DESIRED-STATE and RECONCILE logic, not that nginx itself works.
 */
class FakeGatewayDriver implements GatewayDriver {
  calls: { routes: DesiredRoute[] }[] = [];
  shouldFail = false;

  async apply(_gateway: unknown, routes: DesiredRoute[]): Promise<void> {
    this.calls.push({ routes: routes.map((r) => ({ ...r })) });
    if (this.shouldFail) throw new Error('fake gateway apply failure');
  }
}

/** Custom-hostname plan — records every DNS call so tests can assert exact rename/cleanup sequences, same "inject a fake at the one seam" pattern as FakeGatewayDriver above. */
class FakeDnsProvider implements DnsProvider {
  srvEnsured: SrvRecordInput[] = [];
  srvRemoved: string[] = [];
  addressEnsured: AddressRecordInput[] = [];
  addressRemoved: string[] = [];
  unavailableHostnames = new Set<string>();
  isHostnameAvailableShouldThrow = false;
  /** Names this fake provider is not authoritative for — the real one's "outside the managed zone". */
  unpublishableHostnames = new Set<string>();
  /** Names whose publish attempt fails, to exercise the "keep the old record" path. */
  ensureShouldFailFor = new Set<string>();

  async ensureSrv(input: SrvRecordInput): Promise<void> {
    if (this.ensureShouldFailFor.has(input.hostname)) throw new Error(`fake provider refuses ${input.hostname}`);
    this.srvEnsured.push(input);
  }

  async removeSrv(hostname: string): Promise<void> {
    this.srvRemoved.push(hostname);
  }

  async ensureAddressRecord(input: AddressRecordInput): Promise<void> {
    this.addressEnsured.push(input);
  }

  async removeAddressRecord(hostname: string): Promise<void> {
    this.addressRemoved.push(hostname);
  }

  async isHostnameAvailable(hostname: string): Promise<boolean> {
    if (this.isHostnameAvailableShouldThrow) throw new Error('fake DNS provider outage');
    return !this.unavailableHostnames.has(hostname);
  }

  canPublish(hostname: string): boolean {
    return !this.unpublishableHostnames.has(hostname);
  }

  reset(): void {
    this.srvEnsured = [];
    this.srvRemoved = [];
    this.addressEnsured = [];
    this.addressRemoved = [];
    this.unavailableHostnames = new Set();
    this.isHostnameAvailableShouldThrow = false;
    this.unpublishableHostnames = new Set();
    this.ensureShouldFailFor = new Set();
  }
}

describe('Public-exposure gateway (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let gatewayService: GatewayService;
  let fakeDriver: FakeGatewayDriver;
  let fakeDns: FakeDnsProvider;
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let gatewayId: string;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  function authedAsOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }

  beforeAll(async () => {
    fakeDriver = new FakeGatewayDriver();
    fakeDns = new FakeDnsProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GATEWAY_DRIVER)
      .useValue(fakeDriver)
      .overrideProvider(DNS_PROVIDER)
      .useValue(fakeDns)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    gatewayService = app.get(GatewayService);

    const passwordHash = await argon2.hash('AdminPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `gw-admin-${suffix}@gxhost.local`, username: `gw-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `gw-admin-${suffix}@gxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `gw-owner-${suffix}@gxhost.local`, username: `gw-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const ownerLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `gw-owner-${suffix}@gxhost.local`, password: 'AdminPass!234567' },
    });
    ownerToken = JSON.parse(ownerLogin.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `gw-e2e-${suffix}`, name: 'Gateway E2E Location' } });
    locationId = loc.id;

    const group = await prisma.templateGroup.create({ data: { name: `gw-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'gw-e2e Paper',
        author: 'test',
        dockerImages: { default: 'ghcr.io/parkervcp/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\necho installing',
      },
    });
    templateId = template.id;

    const gateway = await asAdmin((tx) =>
      tx.gateway.create({
        data: {
          name: `gw-e2e-${suffix}`,
          publicHost: '203.0.113.50',
          tunnelIp: '10.10.9.1',
          controlUrl: 'http://10.10.9.1:9443',
        },
      }),
    );
    gatewayId = gateway.id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.publicRoute.deleteMany({ where: { gatewayId } }));
    await asAdmin((tx) => tx.gateway.deleteMany({ where: { id: gatewayId } }));
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { ownerId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { locationId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: { in: [`gw-admin-${suffix}@gxhost.local`, `gw-owner-${suffix}@gxhost.local`] } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  async function makeNode(nameSuffix: string, tunnelIp: string | null, allocPort: number) {
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `gw-e2e-node-${nameSuffix}-${suffix}`,
        fqdn: `gw-e2e-node-${nameSuffix}-${suffix}.test`,
        tunnelIp: tunnelIp ?? undefined,
        memoryTotalMb: 4096,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
      },
    });
    await authed(`/api/admin/nodes/${node.id}/allocations`, {
      method: 'POST',
      payload: { ip: `203.0.${nameSuffix.charCodeAt(0)}.10`, startPort: allocPort, endPort: allocPort },
    });
    return node.id;
  }

  let planCounter = 0;
  async function makePlan(memoryMb: number) {
    const tag = `${suffix}-${++planCounter}`;
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `gw-e2e-plan-${tag}`, slug: `gw-e2e-plan-${tag}`, memoryMb, diskMb: 512 },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  it('creates a pending PublicRoute automatically when the server is created, on the same port as its allocation', async () => {
    const nodeId = await makeNode('active', '10.10.9.2', 25601);
    const planId = await makePlan(400);

    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e server' },
    });
    expect(res.statusCode).toBe(202);
    const serverId = JSON.parse(res.body).id as string;

    const route = await asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }));
    expect(route).not.toBeNull();
    expect(route!.state).toBe('pending');
    expect(route!.publicPort).toBe(25601);
    expect(route!.gatewayId).toBe(gatewayId);
  });

  it('is idempotent: calling ensureRouteForServer twice never creates a second route', async () => {
    const nodeId = await makeNode('idem', '10.10.9.3', 25602);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e idem' } });
    const serverId = JSON.parse(res.body).id as string;

    await gatewayService.ensureRouteForServer(serverId);
    await gatewayService.ensureRouteForServer(serverId);

    const routes = await asAdmin((tx) => tx.publicRoute.findMany({ where: { serverId } }));
    expect(routes).toHaveLength(1);
  });

  it('picks the next free public port when the preferred one is already taken on the same gateway', async () => {
    // Two different nodes whose allocation pools happen to share port
    // 25603 (a real scenario — every node's own range is independent).
    const nodeA = await makeNode('collideA', '10.10.9.4', 25603);
    const nodeB = await makeNode('collideB', '10.10.9.5', 25603);
    const planId = await makePlan(400);

    const resA = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId: nodeA, templateId, planId, name: 'gw-e2e collide A' } });
    const resB = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId: nodeB, templateId, planId, name: 'gw-e2e collide B' } });
    const serverAId = JSON.parse(resA.body).id as string;
    const serverBId = JSON.parse(resB.body).id as string;

    const routeA = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId: serverAId } }));
    const routeB = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId: serverBId } }));
    expect(routeA.publicPort).toBe(25603);
    expect(routeB.publicPort).not.toBe(25603);
  });

  it('reconcile pushes the real node tunnel IP + allocation port to the driver and marks the route active', async () => {
    const nodeId = await makeNode('reconcile', '10.10.9.6', 25610);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e reconcile' } });
    const serverId = JSON.parse(res.body).id as string;

    fakeDriver.calls = [];
    fakeDriver.shouldFail = false;
    const reconcileRes = await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    expect(reconcileRes.statusCode).toBe(201);

    const pushed = fakeDriver.calls.flatMap((c) => c.routes).find((r) => r.serverId === serverId);
    expect(pushed).toBeDefined();
    expect(pushed!.targetIp).toBe('10.10.9.6');
    expect(pushed!.targetPort).toBe(25610);
    expect(pushed!.publicPort).toBe(25610);

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.state).toBe('active');
    expect(route.appliedAt).not.toBeNull();
  });

  it('a failed reconcile marks the route failed WITHOUT touching the server or its allocation', async () => {
    const nodeId = await makeNode('failcase', '10.10.9.7', 25620);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e fail' } });
    const serverId = JSON.parse(res.body).id as string;

    const before = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    const allocationBefore = await asAdmin((tx) => tx.allocation.findFirstOrThrow({ where: { serverId } }));

    fakeDriver.shouldFail = true;
    const reconcileRes = await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    expect(reconcileRes.statusCode).toBe(201);
    fakeDriver.shouldFail = false;

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.state).toBe('failed');
    expect(route.lastError).toContain('fake gateway apply failure');

    const after = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    const allocationAfter = await asAdmin((tx) => tx.allocation.findFirstOrThrow({ where: { serverId } }));
    expect(after.status).toBe(before.status);
    expect(allocationAfter.id).toBe(allocationBefore.id);
    expect(allocationAfter.isPrimary).toBe(true);
  });

  it('a route for a node with no tunnelIp is skipped (marked failed), never blocks other routes on the same gateway', async () => {
    const nodeId = await makeNode('notunnel', null, 25630);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e no-tunnel' } });
    const serverId = JSON.parse(res.body).id as string;

    fakeDriver.shouldFail = false;
    const reconcileRes = await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    expect(reconcileRes.statusCode).toBe(201);

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.state).toBe('failed');
    expect(route.lastError).toMatch(/tunnel/i);

    const pushed = fakeDriver.calls.flatMap((c) => c.routes).find((r) => r.serverId === serverId);
    expect(pushed).toBeUndefined();
  });

  // Not exercised through DELETE /api/admin/servers/:id: that path calls
  // AgentClient.deleteServer against the node's real controlAddress, which
  // has no live agent in this suite — servers.e2e-spec.ts's own afterAll
  // comment notes the exact same limitation and never calls that endpoint
  // either. What actually matters for the public-exposure feature is the
  // DB-level guarantee `GatewayService.markRemoving` and `ServersService.
  // remove()` rely on (public_routes.server_id ON DELETE CASCADE), so this
  // replays that method's own DB steps (clear isPrimary, then delete the
  // server row) directly, the same way servers.e2e-spec.ts's afterAll does.
  it('marking a route removing, then deleting the server, cascades the PublicRoute away', async () => {
    const nodeId = await makeNode('delete', '10.10.9.8', 25640);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e delete' } });
    const serverId = JSON.parse(res.body).id as string;

    expect(await asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }))).not.toBeNull();

    await gatewayService.markRemoving(serverId);
    const marked = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(marked.state).toBe('removing');

    await asAdmin((tx) => tx.allocation.updateMany({ where: { serverId }, data: { isPrimary: false } }));
    await asAdmin((tx) => tx.server.delete({ where: { id: serverId } }));

    expect(await asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }))).toBeNull();
  });

  // ---- custom-hostname plan ----

  it('setting a custom hostname stores the label, and reconcile publishes SRV + address record for the composed FQDN', async () => {
    const nodeId = await makeNode('hostname-set', '10.10.9.11', 25670);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname set' } });
    const serverId = JSON.parse(res.body).id as string;

    const updated = await gatewayService.setCustomHostname(serverId, 'survival');
    expect(updated.customHostname).toBe('survival');

    fakeDns.reset();
    fakeDriver.shouldFail = false;
    const reconcileRes = await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    expect(reconcileRes.statusCode).toBe(201);

    const fqdn = 'survival.mc.gw-e2e-test.local';
    // target must be the hostname itself, never the gateway's raw IP —
    // the DNS spec (and real providers like PowerDNS/Cloudflare) rejects
    // a literal address there ("SRV target must be a hostname"); the
    // same fqdn is what the address-record assertion right below
    // resolves to that IP.
    expect(fakeDns.srvEnsured).toContainEqual(expect.objectContaining({ hostname: fqdn, target: fqdn }));
    expect(fakeDns.addressEnsured).toContainEqual(expect.objectContaining({ hostname: fqdn, ip: '203.0.113.50' }));

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.dnsSyncedHostname).toBe(fqdn);
  });

  it('renaming the hostname removes the OLD DNS records and publishes the new ones on the next reconcile', async () => {
    const nodeId = await makeNode('hostname-rename', '10.10.9.12', 25671);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname rename' } });
    const serverId = JSON.parse(res.body).id as string;

    await gatewayService.setCustomHostname(serverId, 'oldname');
    await authed('/api/admin/gateways/reconcile', { method: 'POST' }); // sync 'oldname' first

    await gatewayService.setCustomHostname(serverId, 'newname');
    fakeDns.reset();
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });

    expect(fakeDns.srvRemoved).toContain('oldname.mc.gw-e2e-test.local');
    expect(fakeDns.addressRemoved).toContain('oldname.mc.gw-e2e-test.local');
    expect(fakeDns.srvEnsured).toContainEqual(expect.objectContaining({ hostname: 'newname.mc.gw-e2e-test.local' }));

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.dnsSyncedHostname).toBe('newname.mc.gw-e2e-test.local');
  });

  /**
   * The rename above used to delete the old records BEFORE trying to
   * publish the new ones, so that a rename could never leave the
   * previous name resolving. Found live that the ordering had a much
   * worse failure mode than the one it prevented: a customer set a
   * hostname the DNS provider could not publish, the old working record
   * was deleted, the new one never appeared, and the server was left
   * with no address at all while the panel showed the new name as its
   * connection address.
   */
  it('um rename que não consegue publicar mantém o endereço antigo no ar, em vez de deixar o servidor sem nenhum', async () => {
    const nodeId = await makeNode('hostname-keep-old', '10.10.9.18', 25677);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname keep old' } });
    const serverId = JSON.parse(res.body).id as string;

    await gatewayService.setCustomHostname(serverId, 'working');
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    const before = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(before.dnsSyncedHostname).toBe('working.mc.gw-e2e-test.local');

    fakeDns.reset();
    fakeDns.ensureShouldFailFor.add('broken.mc.gw-e2e-test.local');
    await gatewayService.setCustomHostname(serverId, 'broken');
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });

    expect(fakeDns.srvRemoved).not.toContain('working.mc.gw-e2e-test.local');
    expect(fakeDns.addressRemoved).not.toContain('working.mc.gw-e2e-test.local');
    const after = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(after.dnsSyncedHostname).toBe('working.mc.gw-e2e-test.local');
  });

  /**
   * Refused at save time rather than accepted and retried forever. The
   * reconciler swallows publish failures on purpose (DNS is best-effort
   * — a customer can always fall back to ip:port), which is right for
   * an outage and wrong for a name that can never work: it turns a
   * permanent misconfiguration into a silent one.
   */
  it('um hostname que o provider não consegue publicar é recusado na hora de salvar', async () => {
    const nodeId = await makeNode('hostname-unpublishable', '10.10.9.19', 25678);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname unpublishable' } });
    const serverId = JSON.parse(res.body).id as string;

    fakeDns.reset();
    fakeDns.unpublishableHostnames.add('forapex.mc.gw-e2e-test.local');

    await expect(gatewayService.setCustomHostname(serverId, 'forapex')).rejects.toThrow(/não pode ser publicado/);

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.customHostname).toBeNull();
  });

  it('clearing the hostname removes its DNS and falls back to the shortId-derived scheme on the next reconcile', async () => {
    const nodeId = await makeNode('hostname-clear', '10.10.9.13', 25672);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname clear' } });
    const serverId = JSON.parse(res.body).id as string;
    const shortId = (JSON.parse(res.body).shortId as string).toLowerCase();

    await gatewayService.setCustomHostname(serverId, 'temporary');
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });

    await gatewayService.setCustomHostname(serverId, null);
    fakeDns.reset();
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });

    expect(fakeDns.srvRemoved).toContain('temporary.mc.gw-e2e-test.local');
    const derivedFqdn = `${shortId}.mc.gw-e2e-test.local`;
    expect(fakeDns.srvEnsured).toContainEqual(expect.objectContaining({ hostname: derivedFqdn }));

    const route = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(route.customHostname).toBeNull();
    expect(route.dnsSyncedHostname).toBe(derivedFqdn);
  });

  // The actual regression test for the pre-existing bug found while
  // building this feature: deleting a server never cleaned up its DNS
  // record at all (the reconciler only ever saw the row AFTER it was
  // already hard-deleted). Asserts the cleanup happens synchronously in
  // markRemoving, with NO reconcile call in between.
  it('deleting a server with a synced hostname removes its DNS immediately at markRemoving time, before any reconcile', async () => {
    const nodeId = await makeNode('hostname-delete', '10.10.9.14', 25673);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname delete' } });
    const serverId = JSON.parse(res.body).id as string;

    await gatewayService.setCustomHostname(serverId, 'doomed');
    await authed('/api/admin/gateways/reconcile', { method: 'POST' });
    const synced = await asAdmin((tx) => tx.publicRoute.findUniqueOrThrow({ where: { serverId } }));
    expect(synced.dnsSyncedHostname).toBe('doomed.mc.gw-e2e-test.local');

    fakeDns.reset();
    await gatewayService.markRemoving(serverId); // no reconcile call after this

    expect(fakeDns.srvRemoved).toContain('doomed.mc.gw-e2e-test.local');
    expect(fakeDns.addressRemoved).toContain('doomed.mc.gw-e2e-test.local');

    await asAdmin((tx) => tx.allocation.updateMany({ where: { serverId }, data: { isPrimary: false } }));
    await asAdmin((tx) => tx.server.delete({ where: { id: serverId } }));
  });

  it('a live-availability check failure fails OPEN — the save still succeeds despite a simulated DNS provider outage', async () => {
    const nodeId = await makeNode('hostname-failopen', '10.10.9.15', 25674);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname failopen' } });
    const serverId = JSON.parse(res.body).id as string;

    fakeDns.isHostnameAvailableShouldThrow = true;
    try {
      const updated = await gatewayService.setCustomHostname(serverId, 'stillworks');
      expect(updated.customHostname).toBe('stillworks');
    } finally {
      fakeDns.isHostnameAvailableShouldThrow = false;
    }
  });

  it('rejects a reserved word via the real client HTTP endpoint (400)', async () => {
    const nodeId = await makeNode('hostname-reserved', '10.10.9.16', 25675);
    const planId = await makePlan(400);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname reserved' } });
    const serverId = JSON.parse(res.body).id as string;

    const patch = await authedAsOwner(`/api/client/servers/${serverId}/hostname`, { method: 'PATCH', payload: { hostname: 'www' } });
    expect(patch.statusCode).toBe(400);
  });

  it('rejects a hostname already claimed by another server via the real unique constraint (409)', async () => {
    const nodeIdA = await makeNode('hostname-dupA', '10.10.9.17', 25676);
    const nodeIdB = await makeNode('hostname-dupB', '10.10.9.18', 25677);
    const planId = await makePlan(400);
    const resA = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId: nodeIdA, templateId, planId, name: 'gw-e2e hostname dup A' } });
    const resB = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId: nodeIdB, templateId, planId, name: 'gw-e2e hostname dup B' } });
    const serverAId = JSON.parse(resA.body).id as string;
    const serverBId = JSON.parse(resB.body).id as string;

    const patchA = await authedAsOwner(`/api/client/servers/${serverAId}/hostname`, { method: 'PATCH', payload: { hostname: 'claimedfirst' } });
    expect(patchA.statusCode).toBe(200);

    const patchB = await authedAsOwner(`/api/client/servers/${serverBId}/hostname`, { method: 'PATCH', payload: { hostname: 'claimedfirst' } });
    expect(patchB.statusCode).toBe(409);
  });

  it('rejects setting a hostname when the server has no PublicRoute yet (no active Gateway) (409)', async () => {
    await asAdmin((tx) => tx.gateway.update({ where: { id: gatewayId }, data: { isActive: false } }));
    try {
      const nodeId = await makeNode('hostname-noroute', '10.10.9.19', 25678);
      const planId = await makePlan(400);
      const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e hostname no route' } });
      const serverId = JSON.parse(res.body).id as string;

      const patch = await authedAsOwner(`/api/client/servers/${serverId}/hostname`, { method: 'PATCH', payload: { hostname: 'nogatewayyet' } });
      expect(patch.statusCode).toBe(409);
    } finally {
      await asAdmin((tx) => tx.gateway.update({ where: { id: gatewayId }, data: { isActive: true } }));
    }
  });

  it('a server created with no active Gateway gets no PublicRoute at all (feature stays off)', async () => {
    await asAdmin((tx) => tx.gateway.update({ where: { id: gatewayId }, data: { isActive: false } }));
    try {
      const nodeId = await makeNode('inactive-gw', '10.10.9.9', 25650);
      const planId = await makePlan(400);
      const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'gw-e2e inactive gateway' } });
      const serverId = JSON.parse(res.body).id as string;

      const route = await asAdmin((tx) => tx.publicRoute.findUnique({ where: { serverId } }));
      expect(route).toBeNull();
    } finally {
      await asAdmin((tx) => tx.gateway.update({ where: { id: gatewayId }, data: { isActive: true } }));
    }
  });
});
