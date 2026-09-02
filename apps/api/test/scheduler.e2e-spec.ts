import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Capacity plan Fase 5: automatic node selection (`dto.nodeId` omitted)
 * and the pick→lock→reverify→retry loop.
 */
describe('Scheduler: automatic node selection (e2e)', () => {
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
      data: { email: `sched-admin-${suffix}@pxhost.local`, username: `sched-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `sched-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `sched-owner-${suffix}@pxhost.local`, username: `sched-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;

    const loc = await prisma.location.create({ data: { shortCode: `sched-e2e-${suffix}`, name: 'Scheduler E2E Location' } });
    locationId = loc.id;

    const group = await prisma.templateGroup.create({ data: { name: `sched-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'sched-e2e Paper',
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
      where: { email: { in: [`sched-admin-${suffix}@pxhost.local`, `sched-owner-${suffix}@pxhost.local`] } },
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
  async function makeNode(overrides: Partial<{ memoryTotalMb: number; maintenanceMode: boolean; isPublic: boolean }> = {}) {
    const tag = `${suffix}-${String(++nodeCounter).padStart(3, '0')}`;
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `sched-e2e-node-${tag}`,
        fqdn: `sched-e2e-node-${tag}.test`,
        memoryTotalMb: overrides.memoryTotalMb ?? 8192,
        memoryOverallocatePct: 0,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
        maintenanceMode: overrides.maintenanceMode ?? false,
        isPublic: overrides.isPublic ?? true,
      },
    });
    await authed(`/api/admin/nodes/${node.id}/allocations`, {
      method: 'POST',
      payload: { ip: `203.3.${nodeCounter}.10`, startPort: 29000, endPort: 29009 },
    });
    return node.id;
  }

  let planCounter = 0;
  async function makePlan(memoryMb: number, maxSlots?: number) {
    const tag = `${suffix}-${++planCounter}`;
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `sched-e2e-plan-${tag}`, slug: `sched-e2e-plan-${tag}`, memoryMb, diskMb: 512, ...(maxSlots !== undefined ? { maxSlots } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  function createAuto(payload: { ownerId: string; templateId: string; planId: string; name: string }) {
    return authed('/api/admin/servers', { method: 'POST', payload });
  }

  // The whole suite runs against ONE shared dev database, and Jest runs
  // spec FILES in parallel workers by default — so without this, the
  // scheduler (which has no default location scope, matching production:
  // a single fleet, not per-tenant regions) would happily consider nodes
  // belonging to servers.e2e-spec.ts or any other concurrently-running
  // suite as real candidates. Every test below restricts its plan to
  // exactly the node(s) IT constructed, the same way slots.e2e-spec.ts's
  // cross-node race test already had to.
  function restrictPlan(planId: string, nodeIds: string[]) {
    return authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: nodeIds.map((nodeId) => ({ nodeId })) } });
  }

  it('picks the emptier node when both are eligible', async () => {
    const nearlyFull = await makeNode({ memoryTotalMb: 1000 });
    const empty = await makeNode({ memoryTotalMb: 1000 });
    const fillerPlanId = await makePlan(900);
    await restrictPlan(fillerPlanId, [nearlyFull]);
    // Pin the filler directly so this setup doesn't itself depend on the scheduler.
    const fillerRes = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId: nearlyFull, templateId, planId: fillerPlanId, name: 'filler' },
    });
    expect(fillerRes.statusCode).toBe(202);

    const planId = await makePlan(50);
    await restrictPlan(planId, [nearlyFull, empty]);
    const res = await createAuto({ ownerId, templateId, planId, name: 'auto pick emptiest' });
    expect(res.statusCode).toBe(202);
    const serverId = JSON.parse(res.body).id as string;
    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.nodeId).toBe(empty);
  });

  it('never selects a node in maintenance mode', async () => {
    // A deliberately huge maintenance node that WOULD win on fit alone
    // if it were eligible, plus one ordinary good node as the only real
    // candidate — restricted to exactly these two so no other suite's
    // nodes can interfere.
    const maintenance = await makeNode({ maintenanceMode: true, memoryTotalMb: 999_999 });
    const good = await makeNode();
    const planId = await makePlan(400);
    await restrictPlan(planId, [maintenance, good]);
    const res = await createAuto({ ownerId, templateId, planId, name: 'no maintenance nodes' });
    expect(res.statusCode).toBe(202);
    const serverId = JSON.parse(res.body).id as string;
    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.nodeId).toBe(good);
  });

  it('never selects a private (isPublic=false) node', async () => {
    const priv = await makeNode({ isPublic: false, memoryTotalMb: 999_999 }); // deliberately huge so it WOULD win on fit alone if eligible
    const good = await makeNode();
    const planId = await makePlan(400);
    await restrictPlan(planId, [priv, good]);
    const res = await createAuto({ ownerId, templateId, planId, name: 'no private nodes' });
    expect(res.statusCode).toBe(202);
    const serverId = JSON.parse(res.body).id as string;
    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.nodeId).toBe(good);
  });

  it('an explicit nodeId is honored and never reallocated, even if it is a worse fit than another node', async () => {
    const worseFit = await makeNode({ memoryTotalMb: 500 });
    await makeNode({ memoryTotalMb: 999_999 }); // a much better node exists, but must be ignored
    const planId = await makePlan(400);

    const res = await authed('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId: worseFit, templateId, planId, name: 'explicit pin' },
    });
    expect(res.statusCode).toBe(202);
    const serverId = JSON.parse(res.body).id as string;
    const server = await asAdmin((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.nodeId).toBe(worseFit);
  });

  it('a plan with no slots left fails fast with NO_SLOTS on automatic selection, regardless of node availability', async () => {
    const nodeA = await makeNode();
    const nodeB = await makeNode();
    const planId = await makePlan(400, 1);
    await restrictPlan(planId, [nodeA, nodeB]);
    const first = await createAuto({ ownerId, templateId, planId, name: 'fills the only slot' });
    expect(first.statusCode).toBe(202);

    // The retry loop's `if (message.startsWith('NO_SLOTS:')) throw` (see
    // ServersService.create) makes this fail on the FIRST attempt, not
    // after 3 — not independently observable from a black-box e2e
    // response (both look identical), so this test asserts the
    // behavior that actually matters to a caller: a definitive 409, not
    // an eventual one.
    const second = await createAuto({ ownerId, templateId, planId, name: 'no slots left' });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain('NO_SLOTS');
  });

  it('retries on a different node when the scheduler-picked node loses a real concurrent race', async () => {
    // Both nodes start identical and empty — the deterministic tie-break
    // (score → priority → free RAM → node id) means EVERY concurrent
    // automatic request independently computes the SAME "best" node
    // first. Only one of the two concurrent 500MB-ceiling requests can
    // actually fit there; the other must hit NO_CAPACITY under the real
    // lock, exclude that node, and retry onto the second one.
    const nodeA = await makeNode({ memoryTotalMb: 500 });
    const nodeB = await makeNode({ memoryTotalMb: 500 });
    const planId = await makePlan(400);
    // Scoped to exactly these two nodes — without this, the much emptier
    // leftover nodes from earlier tests in this file (same location, all
    // still eligible) would outrank both A and B on fit alone, and the
    // scheduler would correctly (and boringly) put both servers on one of
    // THOSE instead of ever touching A or B, which isn't the race this
    // test wants to prove anything about.
    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId: nodeA }, { nodeId: nodeB }] } });

    const [r1, r2] = await Promise.all([
      createAuto({ ownerId, templateId, planId, name: 'race 1' }),
      createAuto({ ownerId, templateId, planId, name: 'race 2' }),
    ]);
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);

    const servers = await asAdmin((tx) => tx.server.findMany({ where: { planId }, select: { nodeId: true } }));
    expect(servers).toHaveLength(2);
    const nodeIds = new Set(servers.map((s) => s.nodeId));
    expect(nodeIds).toEqual(new Set([nodeA, nodeB])); // one on each — proves the retry actually landed on the OTHER node, not a fluke
  });
});
