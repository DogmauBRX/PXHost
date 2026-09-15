import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { GATEWAY_DRIVER, type DesiredRoute, type GatewayDriver } from '../src/modules/gateway/gateway-driver.interface';
import { GatewayService } from '../src/modules/gateway/gateway.service';

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

describe('Public-exposure gateway (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let gatewayService: GatewayService;
  let fakeDriver: FakeGatewayDriver;
  let adminToken: string;
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

  beforeAll(async () => {
    fakeDriver = new FakeGatewayDriver();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GATEWAY_DRIVER)
      .useValue(fakeDriver)
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
