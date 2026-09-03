import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * End-to-end proof of milestone M4's stated DoD: "Admin creates a node,
 * gets a bootstrap token, the agent registers and heartbeats; node goes
 * online." Exercises the exact same HTTP surface the real Go agent calls
 * (see agent/cmd/pxagent's bootstrap/serve commands) — this test plays
 * the agent's role by hand so the whole handshake is verified without
 * needing a live Docker host in this suite.
 */
describe('Nodes: bootstrap + heartbeat (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let nodeId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('AdminPass!234567', {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
      hashLength: 32,
    });
    await prisma.user.create({
      data: {
        email: `nodes-admin-${suffix}@pxhost.local`,
        username: `nodes-admin-${suffix}`,
        passwordHash,
        globalRole: 'admin',
        isActive: true,
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `nodes-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `nodes-e2e-${suffix}`, name: 'Nodes E2E Location' } });
    locationId = loc.id;
  });

  afterAll(async () => {
    if (nodeId) await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: `nodes-admin-${suffix}@pxhost.local` }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  it('a non-admin user is forbidden from the admin nodes surface', async () => {
    const passwordHash = await argon2.hash('RegularPass!234', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `nodes-regular-${suffix}@pxhost.local`, username: `nodes-regular-${suffix}`, passwordHash, isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `nodes-regular-${suffix}@pxhost.local`, password: 'RegularPass!234' },
    });
    const regularToken = JSON.parse(login.body).accessToken;

    const res = await app.inject({ method: 'GET', url: '/api/admin/nodes', headers: { authorization: `Bearer ${regularToken}` } });
    expect(res.statusCode).toBe(403);

    await prisma.user.updateMany({ where: { email: `nodes-regular-${suffix}@pxhost.local` }, data: { deletedAt: new Date() } });
  });

  it('admin creates a node — starts with health "unknown" (never heartbeated)', async () => {
    const res = await authed('/api/admin/nodes', {
      method: 'POST',
      payload: {
        locationId,
        name: `e2e-node-${suffix}`,
        fqdn: `e2e-node-${suffix}.test`,
        memoryTotalMb: 4096,
        diskTotalMb: 20480,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.healthStatus).toBe('unknown');
    nodeId = body.id;
  });

  let bootstrapToken: string;

  it('admin issues a single-use bootstrap token', async () => {
    const res = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toMatch(/^bst_/);
    bootstrapToken = body.token;
  });

  let nodeToken: string;

  it('the "agent" redeems the bootstrap token for a long-lived node token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: bootstrapToken, hostname: 'e2e-test-host', os: 'linux', kernel: '6.1.0', dockerVersion: '27.0.0', arch: 'amd64' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.nodeUuid).toBe(nodeId);
    expect(body.nodeToken).toMatch(/^.+\..+$/);
    expect(body.heartbeatIntervalSeconds).toBeGreaterThan(0);
    nodeToken = body.nodeToken;
  });

  it('the bootstrap token is single-use — a second redemption is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: bootstrapToken, hostname: 'e2e-test-host-2' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the node reports "online" immediately after bootstrap (bootstrap itself counts as first contact)', async () => {
    const res = await authed(`/api/admin/nodes/${nodeId}`);
    expect(JSON.parse(res.body).healthStatus).toBe('online');
  });

  it('heartbeating with the node token updates health and reported versions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { agentVersion: 'v0.4.0-e2e', dockerVersion: '27.1.0', uptimeSeconds: 42 },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('online');

    const node = await authed(`/api/admin/nodes/${nodeId}`);
    const body = JSON.parse(node.body);
    expect(body.healthStatus).toBe('online');
    expect(body.agentVersion).toBe('v0.4.0-e2e');
    expect(body.dockerVersion).toBe('27.1.0');
    // Capacity plan Fase 7: `uptimeSeconds` has been ACCEPTED since M4 but
    // was silently discarded until now — the previous heartbeat sent it
    // (42) with none of the new reported_* fields, proving both halves at
    // once: an old-format heartbeat still works AND now actually persists.
    expect(body.agentUptimeSeconds).toBe(42);
    expect(body.reportedMemoryTotalMb).toBeNull();
    expect(body.reportedAt).toBeNull();
    expect(body.telemetryDivergence).toEqual({ memory: 'unknown', disk: 'unknown', cpu: 'unknown' });
  });

  it('a heartbeat with full telemetry persists every reported_* column without ever touching the declared ones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: {
        agentVersion: 'v0.4.0-e2e',
        dockerVersion: '27.1.0',
        uptimeSeconds: 99,
        reportedMemoryTotalMb: 32768,
        reportedCpuCount: 8,
        reportedDiskTotalMb: 500000,
        reportedDiskFreeMb: 400000,
        reportedOs: 'linux',
        reportedKernel: '6.1.0-e2e',
        reportedContainersRunning: 3,
      },
    });
    expect(res.statusCode).toBe(201);

    const node = await authed(`/api/admin/nodes/${nodeId}`);
    const body = JSON.parse(node.body);
    expect(body.reportedMemoryTotalMb).toBe(32768);
    expect(body.reportedCpuCount).toBe(8);
    expect(body.reportedDiskTotalMb).toBe(500000);
    expect(body.reportedDiskFreeMb).toBe(400000);
    expect(body.reportedOs).toBe('linux');
    expect(body.reportedKernel).toBe('6.1.0-e2e');
    expect(body.reportedContainersRunning).toBe(3);
    expect(body.reportedAt).not.toBeNull();
    expect(body.agentUptimeSeconds).toBe(99);
    // Declared (test setup used memoryTotalMb: 4096, diskTotalMb: 20480 —
    // both well under what was just reported) never changed.
    expect(body.memoryTotalMb).toBe(4096);
    expect(body.diskTotalMb).toBe(20480);
    expect(body.telemetryDivergence).toEqual({ memory: 'ok', disk: 'ok', cpu: 'unknown' }); // cpu still unknown: cpuTotalPercent defaults to 0 (accounting off)
  });

  it('a heartbeat with full hardware telemetry persists CPU/memory/virtualization detection fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: {
        agentVersion: 'v0.4.0-e2e',
        reportedCpuModel: 'AMD EPYC 7302P 16-Core Processor',
        reportedCpuSockets: 1,
        reportedCpuPhysicalCores: 16,
        reportedCpuUsagePercent: 37,
        reportedLoadAvg1: 2.5,
        reportedMemoryUsedMb: 12000,
        reportedMemoryAvailableMb: 20000,
        reportedVirtualizationSystem: 'kvm',
        reportedVirtualizationRole: 'guest',
      },
    });
    expect(res.statusCode).toBe(201);

    const node = await authed(`/api/admin/nodes/${nodeId}`);
    const body = JSON.parse(node.body);
    expect(body.reportedCpuModel).toBe('AMD EPYC 7302P 16-Core Processor');
    expect(body.reportedCpuSockets).toBe(1);
    expect(body.reportedCpuPhysicalCores).toBe(16);
    expect(body.reportedCpuUsagePercent).toBe(37);
    expect(body.reportedLoadAvg1).toBe(2.5);
    expect(body.reportedMemoryUsedMb).toBe(12000);
    expect(body.reportedMemoryAvailableMb).toBe(20000);
    expect(body.reportedVirtualizationSystem).toBe('kvm');
    expect(body.reportedVirtualizationRole).toBe('guest');
    // Hardware-detection fields are purely informational — they must never
    // affect the declared×reported divergence, which stays scoped to
    // memory/disk/cpu totals from the block above.
    expect(body.telemetryDivergence).toEqual({ memory: 'ok', disk: 'ok', cpu: 'unknown' });
  });

  it('declaring more than the agent actually reports flags "over" — the one dangerous direction', async () => {
    const patchRes = await authed(`/api/admin/nodes/${nodeId}`, { method: 'PATCH', payload: { memoryTotalMb: 65536 } }); // now above the 32768 reported above
    expect(patchRes.statusCode).toBe(200);

    const node = await authed(`/api/admin/nodes/${nodeId}`);
    const body = JSON.parse(node.body);
    expect(body.telemetryDivergence.memory).toBe('over');
    expect(body.telemetryDivergence.disk).toBe('ok'); // untouched — still well under what was reported
  });

  it('a heartbeat with NO reported_* fields at all leaves the previously-reported values untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { agentVersion: 'v0.4.0-e2e-old-agent' }, // simulates an agent binary older than this milestone
    });
    expect(res.statusCode).toBe(201);

    const node = await authed(`/api/admin/nodes/${nodeId}`);
    const body = JSON.parse(node.body);
    expect(body.reportedMemoryTotalMb).toBe(32768); // still the value from two tests ago — never zeroed
    expect(body.agentVersion).toBe('v0.4.0-e2e-old-agent');
    // Same "never zeroed" guarantee for the hardware-detection fields set
    // two tests ago — an agent binary that doesn't collect them yet (or a
    // tick where every hostinfo source failed) must not erase them.
    expect(body.reportedCpuModel).toBe('AMD EPYC 7302P 16-Core Processor');
    expect(body.reportedCpuPhysicalCores).toBe(16);
    expect(body.reportedVirtualizationSystem).toBe('kvm');
  });

  it('a heartbeat with a garbage token is rejected — never silently accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: 'Bearer not-a-real-id.not-a-real-secret' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('a heartbeat with NO token is rejected', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/remote/nodes/heartbeat', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('a user JWT is never accepted on the remote surface — only a node token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('re-bootstrapping the same node revokes the old node token', async () => {
    const tokenRes = await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const secondBootstrapToken = JSON.parse(tokenRes.body).token;

    const bootstrapRes = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/bootstrap',
      payload: { token: secondBootstrapToken, hostname: 'e2e-test-host-rebootstrap' },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    const newNodeToken = JSON.parse(bootstrapRes.body).nodeToken;
    expect(newNodeToken).not.toBe(nodeToken);

    // the OLD node token must no longer work
    const oldTokenHeartbeat = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: {},
    });
    expect(oldTokenHeartbeat.statusCode).toBe(401);

    // the NEW node token works
    const newTokenHeartbeat = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${newNodeToken}` },
      payload: {},
    });
    expect(newTokenHeartbeat.statusCode).toBe(201);
  });

  it('imports an allocation range and rejects a duplicate re-import', async () => {
    const first = await authed(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.113.10', startPort: 25565, endPort: 25567 },
    });
    expect(first.statusCode).toBe(201);
    expect(JSON.parse(first.body)).toEqual({ created: 3, skippedExisting: 0 });

    const second = await authed(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.113.10', startPort: 25565, endPort: 25567 },
    });
    expect(JSON.parse(second.body)).toEqual({ created: 0, skippedExisting: 3 });

    const list = await authed(`/api/admin/nodes/${nodeId}/allocations`);
    expect(JSON.parse(list.body)).toHaveLength(3);
  });

  it('rejects an allocation range larger than the configured maximum', async () => {
    const res = await authed(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.113.20', startPort: 30000, endPort: 32000 },
    });
    expect(res.statusCode).toBe(409);
  });
});
