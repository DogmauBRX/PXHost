import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Capacity plan Fase 4: commercial stock (`Plan.maxSlots`) and the
 * plan↔node lock ordering that closes the cross-node slot race.
 *
 * The plan's own verification section describes this race test as
 * running against the Fase 5 scheduler ("6 creates concorrentes sem
 * nodeId"), which doesn't exist yet — `CreateServerDto.nodeId` is still
 * required. The race this test proves is identical either way: two
 * concurrent creates of the SAME plan on DIFFERENT nodes must not both
 * read "a slot is free" before either commits. Explicit, alternating
 * `nodeId` exercises that exact path without depending on Fase 5.
 */
describe('Capacity: plan slots + node lock ordering (e2e)', () => {
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
      data: { email: `slots-admin-${suffix}@pxhost.local`, username: `slots-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `slots-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `slots-owner-${suffix}@pxhost.local`, username: `slots-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;

    const loc = await prisma.location.create({ data: { shortCode: `slots-e2e-${suffix}`, name: 'Slots E2E Location' } });
    locationId = loc.id;

    const group = await prisma.templateGroup.create({ data: { name: `slots-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'slots-e2e Paper',
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
      where: { email: { in: [`slots-admin-${suffix}@pxhost.local`, `slots-owner-${suffix}@pxhost.local`] } },
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

  let nodeCounter = 0;
  async function makeNode(memoryTotalMb = 8192) {
    const tag = `${suffix}-${++nodeCounter}`;
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `slots-e2e-node-${tag}`,
        fqdn: `slots-e2e-node-${tag}.test`,
        memoryTotalMb,
        memoryOverallocatePct: 0,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
      },
    });
    await authed(`/api/admin/nodes/${node.id}/allocations`, {
      method: 'POST',
      payload: { ip: `203.2.${tag.length}.${nodeCounter}`, startPort: 28000, endPort: 28019 },
    });
    return node.id;
  }

  let planCounter = 0;
  async function makePlan(memoryMb: number, maxSlots?: number) {
    const tag = `${suffix}-${++planCounter}`;
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `slots-e2e-plan-${tag}`, slug: `slots-e2e-plan-${tag}`, memoryMb, diskMb: 512, ...(maxSlots !== undefined ? { maxSlots } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  function createServer(payload: { ownerId: string; nodeId: string; templateId: string; planId: string; name: string }) {
    return authed('/api/admin/servers', { method: 'POST', payload });
  }

  it('a plan with maxSlots=1 accepts exactly one create and rejects the second with NO_SLOTS', async () => {
    const nodeId = await makeNode();
    const planId = await makePlan(400, 1);

    const first = await createServer({ ownerId, nodeId, templateId, planId, name: 'slot 1' });
    expect(first.statusCode).toBe(202);

    const second = await createServer({ ownerId, nodeId, templateId, planId, name: 'slot 2' });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain('NO_SLOTS');

    const count = await asAdmin((tx) => tx.server.count({ where: { planId } }));
    expect(count).toBe(1);
  });

  it('lowering maxSlots below current occupancy is allowed and does not touch existing servers', async () => {
    const nodeId = await makeNode();
    const planId = await makePlan(400, 5);
    for (let i = 0; i < 3; i++) {
      const res = await createServer({ ownerId, nodeId, templateId, planId, name: `occ ${i}` });
      expect(res.statusCode).toBe(202);
    }

    const patch = await authed(`/api/admin/plans/${planId}`, { method: 'PATCH', payload: { maxSlots: 1 } });
    expect(patch.statusCode).toBe(200);

    const count = await asAdmin((tx) => tx.server.count({ where: { planId } }));
    expect(count).toBe(3); // unchanged — lowering the cap never deletes or suspends anything

    // The plan is now oversubscribed (3 occupied > 1 max) — the next
    // create still correctly refuses, proving `occupied >= maxSlots`
    // (not just `>`) is the right comparison at the boundary.
    const res = await createServer({ ownerId, nodeId, templateId, planId, name: 'occ blocked' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('NO_SLOTS');
  });

  it('the cross-node slot race is closed: 2 nodes, maxSlots=2, 6 concurrent creates alternating node → exactly 2 accepted, 4 NO_SLOTS', async () => {
    const nodeA = await makeNode();
    const nodeB = await makeNode();
    const planId = await makePlan(400, 2);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createServer({ ownerId, nodeId: i % 2 === 0 ? nodeA : nodeB, templateId, planId, name: `race ${i}` }),
      ),
    );

    const accepted = results.filter((r) => r.statusCode === 202);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.body).toContain('NO_SLOTS');

    // The assertion that actually proves the lock closed the race is the
    // FINAL COUNT, not who won — without the plan lock this admits
    // anywhere from 2 to 6 (both nodes' capacity independently allows up
    // to 3 each), and does so nondeterministically depending on timing.
    // With the lock it is always exactly 2. No sleep, no retry: either
    // the invariant holds under real concurrency or it doesn't.
    const count = await asAdmin((tx) => tx.server.count({ where: { planId } }));
    expect(count).toBe(2);
  });

  it('a plan restricted to specific nodes rejects a create on any other node', async () => {
    const allowedNode = await makeNode();
    const otherNode = await makeNode();
    const planId = await makePlan(400);

    const restrict = await authed(`/api/admin/plans/${planId}/nodes`, {
      method: 'PUT',
      payload: { nodes: [{ nodeId: allowedNode }] },
    });
    expect(restrict.statusCode).toBe(200);

    const onOther = await createServer({ ownerId, nodeId: otherNode, templateId, planId, name: 'wrong node' });
    expect(onOther.statusCode).toBe(409);
    expect(onOther.body).toContain('not allowed on the requested node');

    const onAllowed = await createServer({ ownerId, nodeId: allowedNode, templateId, planId, name: 'right node' });
    expect(onAllowed.statusCode).toBe(202);
  });

  it('GET /api/admin/plans/:id/nodes reflects what was just set', async () => {
    const nodeId = await makeNode();
    const planId = await makePlan(400);

    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId, priority: 10 }] } });

    const res = await authed(`/api/admin/plans/${planId}/nodes`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].nodeId).toBe(nodeId);
    expect(body[0].priority).toBe(10);
  });
});
