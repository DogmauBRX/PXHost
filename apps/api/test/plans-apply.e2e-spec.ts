import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * M12 (Admin console) DoD: "plan-apply dry run works." `drift()` (the dry
 * run) and `applyToServers()` (the real thing) are proven here against a
 * real Postgres server row and a real HTTP server standing in for the
 * agent — the same reasoning every prior milestone's fake-agent tests
 * use: the point is proving the real fetch()/PATCH request the live
 * resize actually sends, not a mock of AgentClient.
 */
describe('Plans — drift + apply (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  let planId: string;
  let fakeAgent: http.Server;
  let lastLimitsPatch: unknown = null;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function getServerRow(id: string) {
    return asAdmin<{ memoryMb: number; diskMb: number; maxSchedules: number }>((tx) => tx.server.findFirstOrThrow({ where: { id } }));
  }
  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    fakeAgent = http.createServer((req, res) => {
      if (req.method === 'PATCH' && req.url?.endsWith('/limits')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          lastLimitsPatch = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ updated: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address (backups=.1, databases=.2, schedules=.3,
    // subusers=.4, .5 here) — fqdn's real partial-unique index made two
    // spec files racing to claim the same address in parallel Jest
    // workers intermittently fail with a genuine unique-constraint
    // violation (found live building M10/M11).
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.5', resolve));
    const port = (fakeAgent.address() as AddressInfo).port;

    const passwordHash = await argon2.hash('PlanApplyPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `plan-apply-admin-${suffix}@pxhost.local`, username: `plan-apply-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'PlanApplyPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `plan-apply-e2e-${suffix}`, name: 'Plan Apply E2E' } });
    locationId = loc.id;
    await prisma.node.updateMany({ where: { fqdn: '127.0.0.5', deletedAt: null }, data: { deletedAt: new Date() } });
    const node = await prisma.node.create({ data: { locationId, name: `plan-apply-e2e-node-${suffix}`, fqdn: '127.0.0.5', scheme: 'http', daemonPort: port, memoryTotalMb: 8192, diskTotalMb: 81920 } });
    nodeId = node.id;
    await authed(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.123.10', startPort: 27990, endPort: 27990 } });
    const tokenRes = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'plan-apply-e2e-host' } });
    expect(bootstrapRes.statusCode).toBe(201);

    const group = await prisma.templateGroup.create({ data: { name: `plan-apply-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({ data: { groupId, name: 'plan-apply-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' } });
    templateId = template.id;

    const planRes = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `plan-apply-e2e-plan-${suffix}`, slug: `plan-apply-e2e-plan-${suffix}`, memoryMb: 512, diskMb: 1024, cpuLimitPercent: 100 },
    });
    planId = JSON.parse(planRes.body).id;

    const ownerRes = await prisma.user.create({ data: { email: `plan-apply-owner-${suffix}@pxhost.local`, username: `plan-apply-owner-${suffix}`, passwordHash, isActive: true } });
    const createRes = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId: ownerRes.id, nodeId, templateId, planId, name: 'plan-apply-e2e server' } });
    serverId = JSON.parse(createRes.body).id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.updateMany({
      where: { email: { in: [`plan-apply-admin-${suffix}@pxhost.local`, `plan-apply-owner-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('drift is empty right after server creation — the snapshot matches the plan it was created from', async () => {
    const res = await authed(`/api/admin/plans/${planId}/drift`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.affectedCount).toBe(0);
  });

  it('editing the plan makes the server drift, reported field-by-field', async () => {
    const editRes = await authed(`/api/admin/plans/${planId}`, { method: 'PATCH', payload: { memoryMb: 1024, diskMb: 2048 } });
    expect(editRes.statusCode).toBe(200);

    // The server's own row is untouched by editing the plan alone —
    // architecture doc 2.1's whole point.
    const serverBefore = await getServerRow(serverId);
    expect(serverBefore.memoryMb).toBe(512);

    const driftRes = await authed(`/api/admin/plans/${planId}/drift`);
    const drift = JSON.parse(driftRes.body);
    expect(drift.affectedCount).toBe(1);
    const entry = drift.servers[0];
    expect(entry.serverId).toBe(serverId);
    expect(entry.changes).toEqual(
      expect.arrayContaining([
        { field: 'memoryMb', from: 512, to: 1024 },
        { field: 'diskMb', from: 1024, to: 2048 },
      ]),
    );
  });

  it('apply updates the server snapshot AND pushes a real PATCH to the agent', async () => {
    lastLimitsPatch = null;
    const applyRes = await authed(`/api/admin/plans/${planId}/apply`, { method: 'POST' });
    expect(applyRes.statusCode).toBe(201);
    const body = JSON.parse(applyRes.body);
    expect(body.appliedCount).toBe(1);
    expect(body.failures).toEqual([]);

    const serverAfter = await getServerRow(serverId);
    expect(serverAfter.memoryMb).toBe(1024);
    expect(serverAfter.diskMb).toBe(2048);

    expect(lastLimitsPatch).toEqual({ cpuPercent: 100, memoryMb: 1024, swapMb: 0, diskMb: 2048, ioWeight: 500 });

    const driftAfter = await authed(`/api/admin/plans/${planId}/drift`);
    expect(JSON.parse(driftAfter.body).affectedCount).toBe(0);
  });

  it('apply is a no-op (0 applied) once there is nothing left to drift', async () => {
    const res = await authed(`/api/admin/plans/${planId}/apply`, { method: 'POST' });
    const body = JSON.parse(res.body);
    expect(body.appliedCount).toBe(0);
  });

  it('a plan edit that only touches a non-resource field (maxSchedules) never calls the agent at all', async () => {
    await authed(`/api/admin/plans/${planId}`, { method: 'PATCH', payload: { maxSchedules: 9 } });
    lastLimitsPatch = null;
    const res = await authed(`/api/admin/plans/${planId}/apply`, { method: 'POST' });
    expect(JSON.parse(res.body).appliedCount).toBe(1);
    expect(lastLimitsPatch).toBeNull();

    const serverAfter = await getServerRow(serverId);
    expect(serverAfter.maxSchedules).toBe(9);
  });
});
