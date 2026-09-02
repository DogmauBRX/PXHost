import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Capacity plan Fase 2: CPU accounting + the read-only capacity API.
 *
 * The first test here is, per the plan's own verification section, the
 * single most important test in the whole capacity plan: a node left at
 * its defaults (cpuTotalPercent=0, cpuOverallocatePct=-1) must still
 * accept a create even for a plan with a large cpuLimitPercent, now that
 * `assertNodeFits` actually calls `assertCapacity('cpu', ...)`. If this
 * regresses, EVERY existing node in production (all of which predate CPU
 * accounting) would start rejecting every create the moment this ships.
 */
describe('Capacity: CPU accounting + read API (e2e)', () => {
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
    await prisma.user.create({
      data: { email: `cap-admin-${suffix}@pxhost.local`, username: `cap-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `cap-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `cap-owner-${suffix}@pxhost.local`, username: `cap-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;

    const loc = await prisma.location.create({ data: { shortCode: `cap-e2e-${suffix}`, name: 'Capacity E2E Location' } });
    locationId = loc.id;

    const group = await prisma.templateGroup.create({ data: { name: `cap-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'cap-e2e Paper',
        author: 'test',
        dockerImages: { default: 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\necho installing',
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { ownerId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { locationId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({
      where: { email: { in: [`cap-admin-${suffix}@pxhost.local`, `cap-owner-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  function asAdmin<T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  async function makeNode(nameSuffix: string, memoryTotalMb = 8192) {
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `cap-e2e-node-${nameSuffix}-${suffix}`,
        fqdn: `cap-e2e-node-${nameSuffix}-${suffix}.test`,
        memoryTotalMb,
        memoryOverallocatePct: 0,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
      },
    });
    await authed(`/api/admin/nodes/${node.id}/allocations`, {
      method: 'POST',
      payload: { ip: `203.1.${nameSuffix.charCodeAt(0)}.10`, startPort: 27000, endPort: 27009 },
    });
    return node.id;
  }

  let planCounter = 0;
  async function makePlan(memoryMb: number, cpuLimitPercent?: number) {
    const tag = `${suffix}-${++planCounter}`;
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `cap-e2e-plan-${tag}`, slug: `cap-e2e-plan-${tag}`, memoryMb, diskMb: 512, ...(cpuLimitPercent !== undefined ? { cpuLimitPercent } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  it('a node left at CPU-accounting defaults accepts a create even for a large cpuLimitPercent plan', async () => {
    const nodeId = await makeNode('defaults');
    const planId = await makePlan(400, 400); // 4 full cores worth of cpuLimitPercent, on a node with cpuTotalPercent still 0

    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e cpu-default server' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('turning CPU accounting on for a node then actually enforces it (NO_CAPACITY)', async () => {
    const nodeId = await makeNode('cpu-on');
    const patchRes = await authed(`/api/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      payload: { cpuTotalPercent: 200, cpuOverallocatePct: 0 }, // 2 cores, no overallocate
    });
    expect(patchRes.statusCode).toBe(200);

    const planId = await makePlan(400, 300); // 3 cores requested against a 2-core ceiling
    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e cpu-over server' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('NO_CAPACITY');
  });

  it('a fitting CPU request is accepted once accounting is on', async () => {
    const nodeId = await makeNode('cpu-fit');
    await authed(`/api/admin/nodes/${nodeId}`, { method: 'PATCH', payload: { cpuTotalPercent: 200, cpuOverallocatePct: 0 } });

    const planId = await makePlan(400, 100); // 1 core, comfortably under the 2-core ceiling
    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e cpu-fit server' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a PATCH that would turn on CPU overallocate while cpuTotalPercent stays 0 (DB CHECK, not just app logic)', async () => {
    const nodeId = await makeNode('cpu-footgun');
    const res = await authed(`/api/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      payload: { cpuOverallocatePct: 50 }, // real percentage, but cpuTotalPercent is still 0 on this node
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a PATCH that reserves more than the physical total', async () => {
    const nodeId = await makeNode('reserve-footgun', 1000);
    const res = await authed(`/api/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      payload: { memoryReservedMb: 2000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/admin/capacity returns node/server aggregates that agree with the database', async () => {
    const nodeId = await makeNode('dashboard', 2048);
    const planId = await makePlan(500);
    const createRes = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'e2e dashboard server' },
    });
    expect(createRes.statusCode).toBe(202);

    const res = await authed('/api/admin/capacity');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodes.total).toBeGreaterThanOrEqual(1);
    expect(body.servers.total).toBeGreaterThanOrEqual(1);
    const node = body.perNode.find((n: { id: string }) => n.id === nodeId);
    expect(node).toBeDefined();
    expect(node.memory.allocated).toBe(500);
    expect(node.serverCount).toBe(1);
  });

  it('GET /api/admin/capacity/nodes/:id returns a single-node snapshot', async () => {
    const nodeId = await makeNode('detail', 4096);
    const res = await authed(`/api/admin/capacity/nodes/${nodeId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(nodeId);
    expect(body.memory.totalPhysical).toBe(4096);
    expect(body.memory.allocated).toBe(0);
    expect(body.cpu.accountingEnabled).toBe(false);
  });

  it('GET /api/admin/capacity/plans reports occupancy per plan', async () => {
    const nodeId = await makeNode('plan-occ');
    const planId = await makePlan(300);
    await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'e2e plan-occ server' } });

    const res = await authed('/api/admin/capacity/plans');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const plan = body.find((p: { id: string }) => p.id === planId);
    expect(plan).toBeDefined();
    expect(plan.occupied).toBe(1);
  });

  it('POST /api/admin/capacity/simulate reports fit without creating anything', async () => {
    const nodeId = await makeNode('simulate', 500);
    const bigPlanId = await makePlan(600); // exceeds the 500MB node outright

    const res = await authed('/api/admin/capacity/simulate', { method: 'POST', payload: { planId: bigPlanId, nodeId } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].fits).toBe(false);
    expect(body.results[0].reasons.join(' ')).toContain('memory');

    const count = await asAdmin((tx) => tx.server.count({ where: { nodeId } }));
    expect(count).toBe(0); // pure preview — nothing persisted
  });
});
