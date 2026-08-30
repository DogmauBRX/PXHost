import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * End-to-end proof of milestone M5's create transaction (architecture doc
 * 2.6/4.4): capacity accounting, allocation reservation, and — the
 * explicit DoD item — that concurrent creates against a capacity-limited
 * node can never overcommit it. No live agent is bootstrapped for these
 * nodes, so every accepted create's async dispatch fails and the row
 * settles on "install_failed"; that's fine, because dispatch happens
 * strictly AFTER the capacity transaction commits (see
 * ServersService.dispatchToAgent) — it proves the DB-side guarantee
 * without needing a running Go agent in this suite.
 */
describe('Servers: create transaction + capacity race (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let ownerId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('AdminPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `srv-admin-${suffix}@pxhost.local`, username: `srv-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `srv-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `srv-owner-${suffix}@pxhost.local`, username: `srv-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;

    const loc = await prisma.location.create({ data: { shortCode: `srv-e2e-${suffix}`, name: 'Servers E2E Location' } });
    locationId = loc.id;

    const group = await prisma.templateGroup.create({ data: { name: `srv-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'srv-e2e Paper',
        author: 'test',
        dockerImages: { default: 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\necho installing',
      },
    });
    templateId = template.id;

    void admin;
  });

  afterAll(async () => {
    // Allocations marked isPrimary must be cleared before their server can
    // be deleted (DB check constraint allocations_primary_needs_server) —
    // there is no production "delete server" flow on the panel side yet
    // (M5 only added it agent-side), so this ordering is test-only cleanup.
    await asAdmin((tx) =>
      tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }),
    );
    await asAdmin((tx) => tx.server.deleteMany({ where: { ownerId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { locationId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: { in: [`srv-admin-${suffix}@pxhost.local`, `srv-owner-${suffix}@pxhost.local`] } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  // servers/allocations/server_variables are RLS-protected tables (the
  // tenancy backstop, architecture doc 2.4) — PrismaService connects as
  // the restricted `app_user` role for every query, so a direct
  // `prisma.server.findMany(...)` outside `withRLS` is silently filtered
  // to zero rows, not an error. Every direct read/write against those
  // tables in this suite must go through this helper, exactly like
  // production code does.
  function asAdmin<T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  async function makeNode(nameSuffix: string, memoryTotalMb: number, allocationCount: number) {
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `srv-e2e-node-${nameSuffix}-${suffix}`,
        fqdn: `srv-e2e-node-${nameSuffix}-${suffix}.test`,
        memoryTotalMb,
        memoryOverallocatePct: 0,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1, // unlimited: isolate memory as the sole capacity bottleneck
      },
    });
    await authed(`/api/admin/nodes/${node.id}/allocations`, {
      method: 'POST',
      payload: { ip: `203.0.${nameSuffix.charCodeAt(0)}.10`, startPort: 26000, endPort: 26000 + allocationCount - 1 },
    });
    return node.id;
  }

  let planCounter = 0;
  async function makePlan(memoryMb: number) {
    const tag = `${suffix}-${++planCounter}`;
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `srv-e2e-plan-${tag}`, slug: `srv-e2e-plan-${tag}`, memoryMb, diskMb: 512 },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  it('creates a server within capacity, reserves an allocation, snapshots plan limits', async () => {
    const nodeId = await makeNode('single', 1024, 3);
    const planId = await makePlan(400);

    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e single server' },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('installing');

    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: body.id } }));
    expect(server.memoryMb).toBe(400);
    const allocation = await asAdmin((tx) => tx.allocation.findFirst({ where: { serverId: server.id } }));
    expect(allocation).not.toBeNull();
    expect(allocation!.isPrimary).toBe(true);
  });

  it('a plan/node/template still referenced by a server cannot be deleted (in-use guard)', async () => {
    const nodeId = await makeNode('inuse', 1024, 3);
    const planId = await makePlan(400);
    const createRes = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e in-use guard server' },
    });
    expect(createRes.statusCode).toBe(202);

    const planDelete = await authed(`/api/admin/plans/${planId}`, { method: 'DELETE' });
    expect(planDelete.statusCode).toBe(409);

    const nodeDelete = await authed(`/api/admin/nodes/${nodeId}`, { method: 'DELETE' });
    expect(nodeDelete.statusCode).toBe(409);

    const templateDelete = await authed(`/api/admin/eggs/${templateId}`, { method: 'DELETE' });
    expect(templateDelete.statusCode).toBe(409);
  });

  it('rejects a create that would exceed the node capacity ceiling (NO_CAPACITY)', async () => {
    const nodeId = await makeNode('tight', 500, 3);
    const planId = await makePlan(600); // exceeds the 500MB ceiling outright

    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e too big' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('NO_CAPACITY');

    const count = await asAdmin((tx) => tx.server.count({ where: { nodeId } }));
    expect(count).toBe(0);
  });

  it('concurrent creates against a capacity-limited node never overcommit it', async () => {
    // Ceiling is 1024MB, each server requests 400MB -> exactly 2 can fit
    // (800MB used, a 3rd would push to 1200MB > 1024MB ceiling). 5
    // allocations are provisioned so allocation scarcity is never the
    // bottleneck being tested — only the memory capacity race is.
    const nodeId = await makeNode('race', 1024, 5);
    const planId = await makePlan(400);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        authed('/api/admin/servers', {
          method: 'POST',
          payload: { ownerId, nodeId, templateId, planId, name: `e2e race ${i}` },
        }),
      ),
    );

    const accepted = results.filter((r) => r.statusCode === 202);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.body).toContain('NO_CAPACITY');

    // Confirm the DB agrees: exactly 2 rows, 800MB total, no double-booked allocation.
    const servers = await asAdmin((tx) => tx.server.findMany({ where: { nodeId } }));
    expect(servers).toHaveLength(2);
    expect(servers.reduce((sum, s) => sum + s.memoryMb, 0)).toBe(800);

    const allocatedRows = await asAdmin((tx) => tx.allocation.findMany({ where: { nodeId, serverId: { not: null } } }));
    const distinctServerIds = new Set(allocatedRows.map((a) => a.serverId));
    expect(allocatedRows).toHaveLength(2);
    expect(distinctServerIds.size).toBe(2); // no allocation shared between two servers
  });

  it('the agent install-completed callback moves a server to ready, scoped to the reporting node', async () => {
    const nodeId = await makeNode('callback', 1024, 3);
    const planId = await makePlan(400);

    const createRes = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e callback server' },
    });
    const serverId = JSON.parse(createRes.body).id as string;

    const bootstrapTokenRes = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(bootstrapTokenRes.body).token;
    const bootstrapRes = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: bootstrapToken, hostname: 'srv-e2e-agent' },
    });
    const nodeToken = JSON.parse(bootstrapRes.body).nodeToken;

    // A different node's token must not be able to report on this server.
    const otherNodeId = await makeNode('other', 1024, 1);
    const otherBootstrapTokenRes = await authed(`/api/admin/nodes/${otherNodeId}/bootstrap-token`, { method: 'POST' });
    const otherBootstrapRes = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: JSON.parse(otherBootstrapTokenRes.body).token, hostname: 'srv-e2e-other-agent' },
    });
    const otherNodeToken = JSON.parse(otherBootstrapRes.body).nodeToken;

    const wrongNodeAttempt = await app.inject({
      method: 'POST',
      url: `/api/remote/servers/${serverId}/install-completed`,
      headers: { authorization: `Bearer ${otherNodeToken}` },
      payload: { successful: true },
    });
    expect(wrongNodeAttempt.statusCode).toBe(404);

    const rightNodeAttempt = await app.inject({
      method: 'POST',
      url: `/api/remote/servers/${serverId}/install-completed`,
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { successful: true },
    });
    expect(rightNodeAttempt.statusCode).toBe(201);

    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.status).toBe('ready');
    expect(server.installedAt).not.toBeNull();
  });

  // Found live (M11): a WS-driven power action (the actual console
  // Reiniciar/Parar/Iniciar buttons) never touches this API at all — only
  // the agent, authenticated by capability token — so it never reached
  // the activity feed the DoD requires ("every mutation attributed").
  // agent/internal/panel/client.go's ReportActivity + this endpoint close
  // that gap; this test proves the endpoint's own authorization (same
  // node-ownership check as install-completed above), not the agent's Go
  // code, which has no unit coverage of its own for the same reason
  // dockerFull isn't mockable (see agent/README.md bug #16).
  it("the agent's remote activity callback attributes a WS-driven action, scoped to the reporting node", async () => {
    const nodeId = await makeNode('activity', 1024, 1);
    const planId = await makePlan(400);

    const createRes = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e activity server' },
    });
    const serverId = JSON.parse(createRes.body).id as string;

    const bootstrapTokenRes = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapRes = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: JSON.parse(bootstrapTokenRes.body).token, hostname: 'srv-e2e-activity-agent' },
    });
    const nodeToken = JSON.parse(bootstrapRes.body).nodeToken;

    const otherNodeId = await makeNode('activity-other', 1024, 1);
    const otherBootstrapTokenRes = await authed(`/api/admin/nodes/${otherNodeId}/bootstrap-token`, { method: 'POST' });
    const otherBootstrapRes = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: JSON.parse(otherBootstrapTokenRes.body).token, hostname: 'srv-e2e-activity-other-agent' },
    });
    const otherNodeToken = JSON.parse(otherBootstrapRes.body).nodeToken;

    const wrongNodeAttempt = await app.inject({
      method: 'POST',
      url: `/api/remote/servers/${serverId}/activity`,
      headers: { authorization: `Bearer ${otherNodeToken}` },
      payload: { userId: ownerId, event: 'server.power.restart', properties: { previous: 'running', state: 'running' } },
    });
    expect(wrongNodeAttempt.statusCode).toBe(404);

    const rightNodeAttempt = await app.inject({
      method: 'POST',
      url: `/api/remote/servers/${serverId}/activity`,
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { userId: ownerId, event: 'server.power.restart', properties: { previous: 'running', state: 'running' } },
    });
    expect(rightNodeAttempt.statusCode).toBe(201);

    const entry = await asAdmin((tx) => tx.activityLog.findFirstOrThrow({ where: { serverId, event: 'server.power.restart' } }));
    expect(entry.actorId).toBe(ownerId);
    expect(entry.properties).toEqual({ previous: 'running', state: 'running' });
  });
});
