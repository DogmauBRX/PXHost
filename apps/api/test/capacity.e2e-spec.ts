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
      data: { email: `cap-admin-${suffix}@gxhost.local`, username: `cap-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `cap-admin-${suffix}@gxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const owner = await prisma.user.create({
      data: { email: `cap-owner-${suffix}@gxhost.local`, username: `cap-owner-${suffix}`, passwordHash, isActive: true },
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
      where: { email: { in: [`cap-admin-${suffix}@gxhost.local`, `cap-owner-${suffix}@gxhost.local`] } },
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

  // ─────────── Capacity plan (auto-derivation) ───────────

  it('a node left at capacityMode=manual (every node\'s default) is completely unaffected by auto-mode logic, even with zero telemetry', async () => {
    const nodeId = await makeNode('manual-untouched', 4096);
    const res = await authed(`/api/admin/capacity/nodes/${nodeId}`);
    const body = JSON.parse(res.body);
    expect(body.capacityMode).toBe('manual');
    expect(body.acceptsNewServers).toBe(true);
    expect(body.memory.provenance).toBe('manual');
  });

  it('auto mode derives commercial capacity from reported telemetry, not the declared columns', async () => {
    const nodeId = await makeNode('auto-derives', 999); // declared total deliberately wrong/irrelevant in auto mode
    await asAdmin((tx) =>
      tx.node.update({
        where: { id: nodeId },
        data: { capacityMode: 'auto', reportedMemoryTotalMb: 32_000, reportedDiskTotalMb: 500_000, reportedAt: new Date(), lastHeartbeatAt: new Date() },
      }),
    );

    const res = await authed(`/api/admin/capacity/nodes/${nodeId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.capacityMode).toBe('auto');
    expect(body.memory.provenance).toBe('auto');
    expect(body.memory.detected).toBe(32_000);
    expect(body.memory.totalPhysical).toBe(32_000); // NOT 999 — the declared column is ignored in auto mode
    expect(body.acceptsNewServers).toBe(true);
  });

  it('auto mode prefers the cgroup memory LIMIT over the host-wide reported total (the LXC/Proxmox fix)', async () => {
    const nodeId = await makeNode('auto-cgroup', 999);
    await asAdmin((tx) =>
      tx.node.update({
        where: { id: nodeId },
        data: {
          capacityMode: 'auto',
          reportedMemoryTotalMb: 192_000,
          reportedMemoryLimitMb: 32_000,
          reportedDiskTotalMb: 500_000,
          reportedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
      }),
    );

    const res = await authed(`/api/admin/capacity/nodes/${nodeId}`);
    const body = JSON.parse(res.body);
    expect(body.memory.detected).toBe(32_000);
    expect(body.memory.totalPhysical).toBe(32_000);
  });

  it('auto mode with NO telemetry ever received refuses new servers — never falls back to unlimited', async () => {
    const nodeId = await makeNode('auto-unconfigured');
    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { capacityMode: 'auto' } }));

    const snapshot = JSON.parse((await authed(`/api/admin/capacity/nodes/${nodeId}`)).body);
    expect(snapshot.acceptsNewServers).toBe(false);
    expect(snapshot.memory.provenance).toBe('unconfigured');

    const planId = await makePlan(100);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'e2e auto-unconfigured server' } });
    expect(res.statusCode).toBe(409);
  });

  it('auto mode refuses new servers when the node is offline (no recent heartbeat), even with old telemetry on file', async () => {
    const nodeId = await makeNode('auto-offline');
    await asAdmin((tx) =>
      tx.node.update({
        where: { id: nodeId },
        data: { capacityMode: 'auto', reportedMemoryTotalMb: 32_000, reportedAt: new Date(Date.now() - 10 * 60_000), lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
      }),
    );

    const planId = await makePlan(100);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'e2e auto-offline server' } });
    expect(res.statusCode).toBe(409);
  });

  it('auto mode with fresh telemetry accepts a fitting create', async () => {
    const nodeId = await makeNode('auto-accepts', 999);
    await asAdmin((tx) =>
      tx.node.update({
        where: { id: nodeId },
        data: { capacityMode: 'auto', reportedMemoryTotalMb: 8000, reportedDiskTotalMb: 500_000, memoryOverallocatePct: 0, reportedAt: new Date(), lastHeartbeatAt: new Date() },
      }),
    );

    const planId = await makePlan(500);
    const res = await authed('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'e2e auto-accepts server' } });
    expect(res.statusCode).toBe(202);
  });

  it('§14 override guard: declaring a manual total ABOVE the detected hardware is refused without acknowledgeOverride', async () => {
    const nodeId = await makeNode('override-guard', 4096);
    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { reportedMemoryTotalMb: 4096, reportedAt: new Date() } }));

    const blocked = await authed(`/api/admin/nodes/${nodeId}`, { method: 'PATCH', payload: { memoryTotalMb: 999_999 } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain('CAPACITY_OVERRIDE_REQUIRED');

    const stillOld = await authed(`/api/admin/capacity/nodes/${nodeId}`);
    expect(JSON.parse(stillOld.body).memory.totalPhysical).toBe(4096); // refused — nothing changed

    const acknowledged = await authed(`/api/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      payload: { memoryTotalMb: 999_999, acknowledgeOverride: true, changeReason: 'e2e test override' },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(JSON.parse(acknowledged.body).memoryTotalMb).toBe(999_999);
  });

  it('the override guard only applies to the dimension actually being changed, and never re-triggers on an unrelated edit', async () => {
    const nodeId = await makeNode('override-scoped', 4096);
    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { reportedMemoryTotalMb: 100, reportedAt: new Date() } })); // already "over-declared" vs. detected
    // Editing an UNRELATED field (name) must never require acknowledgeOverride, even though memoryTotalMb already exceeds detected.
    const res = await authed(`/api/admin/nodes/${nodeId}`, { method: 'PATCH', payload: { name: `cap-e2e-node-renamed-${suffix}` } });
    expect(res.statusCode).toBe(200);
  });

  it('the override guard is a no-op in auto mode — declared columns are not the ceiling there', async () => {
    const nodeId = await makeNode('override-auto-exempt', 4096);
    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { capacityMode: 'auto', reportedMemoryTotalMb: 100, reportedAt: new Date() } }));
    const res = await authed(`/api/admin/nodes/${nodeId}`, { method: 'PATCH', payload: { memoryTotalMb: 999_999 } });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/admin/capacity/nodes/:id/plans reports derived vagas per plan, naming the limiting resource', async () => {
    const nodeId = await makeNode('node-plans', 1000);
    const planId = await makePlan(300); // 1000/300 = 3 servers worth of memory headroom
    // Restricted to THIS node alone — an unrestricted plan's numbers here
    // would also include every other node in the shared test database.
    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId }] } });

    const res = await authed(`/api/admin/capacity/nodes/${nodeId}/plans`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodeId).toBe(nodeId);
    const row = body.results.find((r: { planId: string }) => r.planId === planId);
    expect(row).toBeDefined();
    expect(row.slots).toBe(3);
    expect(row.limiting).toBe('memory');
  });

  it('GET /api/admin/capacity/plans includes derivedSlots/effectiveSlots honoring maxSlots as an optional ceiling', async () => {
    const nodeId = await makeNode('plan-derived', 1000);
    const createRes = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: `cap-e2e-plan-derived-${suffix}`, slug: `cap-e2e-plan-derived-${suffix}`, memoryMb: 300, diskMb: 512, maxSlots: 2 },
    });
    const planId = JSON.parse(createRes.body).id;
    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId }] } });

    const res = await authed('/api/admin/capacity/plans');
    const plan = JSON.parse(res.body).find((p: { id: string }) => p.id === planId);
    expect(plan.derivedSlots).toBe(3); // 1000/300, scoped to this one restricted node
    expect(plan.effectiveSlots).toBe(2); // min(3, maxSlots=2) — the commercial ceiling wins
    expect(plan.remaining).toBe(2);
  });

  it('derivedSlots is 0 (never unlimited) for a plan with no eligible/accepting node at all', async () => {
    // A node restricted to itself but too small to ever fit: contributes
    // slots:0 (finite), not null — the plan overall must read 0, never
    // "unlimited" for having nothing eligible.
    const nodeId = await makeNode('no-eligible', 100);
    const planId = await makePlan(4096); // far bigger than the 100MB node
    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId }] } });

    const res = await authed('/api/admin/capacity/plans');
    const plan = JSON.parse(res.body).find((p: { id: string }) => p.id === planId);
    expect(plan.derivedSlots).toBe(0);
    expect(plan.perNode[0].slots).toBe(0);
  });

  it('one unlimited-capacity node makes the plan\'s derivedSlots unlimited overall, even alongside a bounded node', async () => {
    const boundedId = await makeNode('mix-bounded', 300); // 1 slot worth
    const unlimitedNode = await prisma.node.create({
      data: {
        locationId,
        name: `cap-e2e-node-mix-unlimited-${suffix}`,
        fqdn: `cap-e2e-node-mix-unlimited-${suffix}.test`,
        memoryTotalMb: 1000,
        memoryOverallocatePct: -1, // unlimited memory ceiling
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
      },
    });
    await authed(`/api/admin/nodes/${unlimitedNode.id}/allocations`, { method: 'POST', payload: { ip: '203.1.250.10', startPort: 27000, endPort: 27009 } });

    const planId = await makePlan(300);
    await authed(`/api/admin/plans/${planId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId: boundedId }, { nodeId: unlimitedNode.id }] } });

    const res = await authed('/api/admin/capacity/plans');
    const plan = JSON.parse(res.body).find((p: { id: string }) => p.id === planId);
    expect(plan.derivedSlots).toBeNull();
    expect(plan.effectiveSlots).toBeNull(); // no maxSlots set on this fixture — nothing to cap it back down
  });
});
