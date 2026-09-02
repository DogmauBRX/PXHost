import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Capacity plan Fase 6: `PlansService.applyToServers` used to run with
 * ZERO capacity check (achado #1 — the biggest overselling hole in the
 * whole system, per the capacity plan). This proves the fix's exact
 * scenario from the plan's own verification section: a node at
 * 900/1000MB from three 300MB servers; raising the plan to 400MB would
 * push it to 1200MB — refused outright, nothing touched, no agent call.
 */
describe('Plans — apply respects node capacity (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let planId: string;
  let serverIds: string[] = [];
  let fakeAgent: http.Server;
  let limitsPatchCount = 0;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
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
        limitsPatchCount++;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address from every other spec file's fake
    // agent (see plans-apply.e2e-spec.ts's own comment on why this
    // matters under parallel Jest workers sharing one dev DB).
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.7', resolve));
    const port = (fakeAgent.address() as AddressInfo).port;

    const passwordHash = await argon2.hash('PlanCapPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `plan-cap-admin-${suffix}@pxhost.local`, username: `plan-cap-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'PlanCapPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `plan-cap-e2e-${suffix}`, name: 'Plan Capacity E2E' } });
    locationId = loc.id;
    await prisma.node.updateMany({ where: { fqdn: '127.0.0.7', deletedAt: null }, data: { deletedAt: new Date() } });
    // ceiling = 1000MB exactly (no reserve, no overallocate) — three
    // 300MB servers land at 900/1000, deliberately close to the wall.
    const node = await prisma.node.create({
      data: { locationId, name: `plan-cap-e2e-node-${suffix}`, fqdn: '127.0.0.7', scheme: 'http', daemonPort: port, memoryTotalMb: 1000, memoryOverallocatePct: 0, diskTotalMb: 1_000_000, diskOverallocatePct: -1 },
    });
    nodeId = node.id;
    await authed(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.124.10', startPort: 27980, endPort: 27982 } });
    const tokenRes = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'plan-cap-e2e-host' } });
    expect(bootstrapRes.statusCode).toBe(201);

    const group = await prisma.templateGroup.create({ data: { name: `plan-cap-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({ data: { groupId, name: 'plan-cap-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' } });
    templateId = template.id;

    const planRes = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `plan-cap-e2e-plan-${suffix}`, slug: `plan-cap-e2e-plan-${suffix}`, memoryMb: 300, diskMb: 1024, cpuLimitPercent: 100 },
    });
    planId = JSON.parse(planRes.body).id;

    const ownerRes = await prisma.user.create({ data: { email: `plan-cap-owner-${suffix}@pxhost.local`, username: `plan-cap-owner-${suffix}`, passwordHash, isActive: true } });
    for (let i = 0; i < 3; i++) {
      const createRes = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId: ownerRes.id, nodeId, templateId, planId, name: `plan-cap-e2e server ${i}` } });
      expect(createRes.statusCode).toBe(202);
      serverIds.push(JSON.parse(createRes.body).id);
    }
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
      where: { email: { in: [`plan-cap-admin-${suffix}@pxhost.local`, `plan-cap-owner-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('the node sits at exactly 900/1000MB after the three creates — the setup this test depends on', async () => {
    const servers = await asAdmin<{ memoryMb: number }[]>((tx) => tx.server.findMany({ where: { nodeId }, select: { memoryMb: true } }));
    expect(servers).toHaveLength(3);
    expect(servers.reduce((sum, s) => sum + s.memoryMb, 0)).toBe(900);
  });

  it("drift's capacity preview shows the wall BEFORE the click", async () => {
    const editRes = await authed(`/api/admin/plans/${planId}`, { method: 'PATCH', payload: { memoryMb: 400 } });
    expect(editRes.statusCode).toBe(200);

    const driftRes = await authed(`/api/admin/plans/${planId}/drift`);
    expect(driftRes.statusCode).toBe(200);
    const drift = JSON.parse(driftRes.body);
    expect(drift.affectedCount).toBe(3);
    expect(drift.capacity).toHaveLength(1);
    expect(drift.capacity[0].nodeId).toBe(nodeId);
    expect(drift.capacity[0].fits).toBe(false);
    expect(drift.capacity[0].reasons.join(' ')).toContain('memory');
    expect(drift.capacity[0].affectedServerIds.sort()).toEqual([...serverIds].sort());
  });

  it('apply refuses outright (409, NO_CAPACITY) — nothing changes, no agent call, no partial application', async () => {
    limitsPatchCount = 0;
    const applyRes = await authed(`/api/admin/plans/${planId}/apply`, { method: 'POST' });
    expect(applyRes.statusCode).toBe(409);
    expect(applyRes.body).toContain('NO_CAPACITY');

    // All three rows still read the OLD value — block refusal, not partial.
    const servers = await asAdmin<{ memoryMb: number }[]>((tx) => tx.server.findMany({ where: { nodeId }, select: { memoryMb: true } }));
    expect(servers.every((s) => s.memoryMb === 300)).toBe(true);
    expect(limitsPatchCount).toBe(0);
  });

  it('freeing capacity on the node lets the same 400MB plan apply cleanly, pushing real PATCHes to the agent', async () => {
    // The plan is still 400MB (set two tests ago) and the node is still
    // at 900/1000 — shrink the OCCUPANCY instead of the plan: delete one
    // server, freeing 300MB, so the remaining 2 × 400MB = 800 <= 1000.
    await asAdmin((tx) => tx.allocation.updateMany({ where: { serverId: serverIds[2] }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.delete({ where: { id: serverIds[2] } }));

    limitsPatchCount = 0;
    const applyRes = await authed(`/api/admin/plans/${planId}/apply`, { method: 'POST' });
    expect(applyRes.statusCode).toBe(201);
    const body = JSON.parse(applyRes.body);
    expect(body.appliedCount).toBe(2);
    expect(body.failures).toEqual([]);
    expect(limitsPatchCount).toBe(2);

    const servers = await asAdmin<{ memoryMb: number }[]>((tx) => tx.server.findMany({ where: { nodeId }, select: { memoryMb: true } }));
    expect(servers.every((s) => s.memoryMb === 400)).toBe(true);
  });
});
