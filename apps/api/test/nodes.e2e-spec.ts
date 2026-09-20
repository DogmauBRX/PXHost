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
        email: `nodes-admin-${suffix}@gxhost.local`,
        username: `nodes-admin-${suffix}`,
        passwordHash,
        globalRole: 'admin',
        isActive: true,
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `nodes-admin-${suffix}@gxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `nodes-e2e-${suffix}`, name: 'Nodes E2E Location' } });
    locationId = loc.id;
  });

  afterAll(async () => {
    if (nodeId) await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: `nodes-admin-${suffix}@gxhost.local` }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  it('a non-admin user is forbidden from the admin nodes surface', async () => {
    const passwordHash = await argon2.hash('RegularPass!234', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `nodes-regular-${suffix}@gxhost.local`, username: `nodes-regular-${suffix}`, passwordHash, isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `nodes-regular-${suffix}@gxhost.local`, password: 'RegularPass!234' },
    });
    const regularToken = JSON.parse(login.body).accessToken;

    const res = await app.inject({ method: 'GET', url: '/api/admin/nodes', headers: { authorization: `Bearer ${regularToken}` } });
    expect(res.statusCode).toBe(403);

    await prisma.user.updateMany({ where: { email: `nodes-regular-${suffix}@gxhost.local` }, data: { deletedAt: new Date() } });
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
    // Capacity plan (auto-derivation) §14: declaring above detected
    // hardware now requires an explicit acknowledgeOverride — see the
    // dedicated override-guard tests in capacity.e2e-spec.ts. This test
    // is about telemetryDivergence, so it acknowledges and moves on.
    const patchRes = await authed(`/api/admin/nodes/${nodeId}`, {
      method: 'PATCH',
      payload: { memoryTotalMb: 65536, acknowledgeOverride: true }, // now above the 32768 reported above
    });
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

  it('reportedMemoryLimitMb (the cgroup memory limit) persists and is never zeroed by a heartbeat that omits it', async () => {
    const withLimit = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { reportedMemoryTotalMb: 192000, reportedMemoryLimitMb: 32000 }, // the LXC case: host-wide total vs. the guest's real cgroup limit
    });
    expect(withLimit.statusCode).toBe(201);

    const afterFirst = JSON.parse((await authed(`/api/admin/nodes/${nodeId}`)).body);
    expect(afterFirst.reportedMemoryLimitMb).toBe(32000);

    // An old-agent-shaped heartbeat (no reportedMemoryLimitMb at all)
    // must leave the previously-reported limit untouched — same
    // never-zeroed guarantee every other reported_* column already has.
    const withoutLimit = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { agentVersion: 'v0.4.0-e2e-old-agent' },
    });
    expect(withoutLimit.statusCode).toBe(201);

    const afterSecond = JSON.parse((await authed(`/api/admin/nodes/${nodeId}`)).body);
    expect(afterSecond.reportedMemoryLimitMb).toBe(32000);
  });

  it('a real change in capacity-relevant telemetry (memory/disk/cpu) between heartbeats is audited as node.telemetry.changed', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { reportedMemoryTotalMb: 16000, reportedCpuCount: 4 },
    });
    expect(first.statusCode).toBe(201);

    // A repeat heartbeat with the SAME values must not add another
    // audit entry — only a genuine change is worth recording.
    const repeat = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { reportedMemoryTotalMb: 16000, reportedCpuCount: 4 },
    });
    expect(repeat.statusCode).toBe(201);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/remote/nodes/heartbeat',
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { reportedMemoryTotalMb: 16000, reportedCpuCount: 8 }, // hardware upgrade, or a mis-sized VM being right-sized
    });
    expect(changed.statusCode).toBe(201);

    // audit_logs carries no RLS policy (a plain global table — see
    // PrismaService's own doc comment on which tables ARE RLS-protected)
    // and the admin HTTP endpoint deliberately omits beforeState/
    // afterState (unbounded JSON, privacy/size reasons) — reading them
    // back requires Prisma directly, same as this session's other audit
    // assertions.
    const entries = await prisma.auditLog.findMany({
      where: { action: 'node.telemetry.changed', targetId: nodeId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[0] as unknown as { beforeState: { reportedCpuCount: number }; afterState: { reportedCpuCount: number } };
    expect(last.afterState.reportedCpuCount).toBe(8);
    expect(last.beforeState.reportedCpuCount).not.toBe(8);
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

  it('lists server uuids for the node — feeds the agent\'s own orphan-reconciliation sweep', async () => {
    // Regression coverage for the production bug this endpoint exists to
    // fix: agent/internal/srv/manager.go's registry is in-memory only, so
    // a server created live is forgotten the instant the agent process
    // restarts. If a DELETE for it then 404s against the manager, the
    // panel's AgentClient.deleteServer treats that as "nothing to tear
    // down" and hard-deletes the row anyway — silently orphaning the real
    // container. This endpoint is what the agent's own periodic sweep
    // (srv.ReconcileOrphans) diffs Docker's container labels against to
    // catch that case on its own, so it has to report every server row
    // that still genuinely exists for this node — no more, no less.
    const emptyRes = await app.inject({
      method: 'GET',
      url: '/api/remote/nodes/servers',
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(JSON.parse(emptyRes.body)).toEqual({ serverUuids: [] });

    // Inserted directly via Prisma, not the admin HTTP API: creating a
    // server for real dispatches synchronously to this node's agent
    // (ServersService.createOnNode awaits dispatchToAgent), and this
    // suite's node is a `.test` fqdn unreachable by design — that call
    // would just burn AgentClient's full 45s timeout for no benefit to
    // what this test actually checks (the listing query, not creation).
    const passwordHash = await argon2.hash('OwnerPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const owner = await prisma.user.create({
      data: { email: `nodes-owner-${suffix}@gxhost.local`, username: `nodes-owner-${suffix}`, passwordHash, isActive: true },
    });
    const shortId = (Date.now().toString(36) + 'aaaaaaaa').slice(0, 8);
    // `servers` carries a real RLS policy (unlike `users`, which is why
    // the prisma.user.create above needed no special context) — a bare
    // prisma.server.create is a normal client-scoped connection with no
    // user/admin context attached, which RLS rejects outright. Same
    // asAdmin/withRLS pattern databases.e2e-spec.ts uses for the same
    // reason.
    const server = await prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.create({
        // status: 'setup_pending' — servers_setup_consistency requires
        // templateId/dockerImage/startupCommand to be null exactly when
        // status is 'setup_pending' (see the Server model's own doc
        // comment on templateId), which is all this test needs: a real
        // row for the endpoint to list, not a fully provisioned server.
        data: { shortId, ownerId: owner.id, nodeId, name: 'nodes-e2e reconcile-test server', memoryMb: 256, diskMb: 512, status: 'setup_pending' },
      }),
    );

    try {
      const withServerRes = await app.inject({
        method: 'GET',
        url: '/api/remote/nodes/servers',
        headers: { authorization: `Bearer ${nodeToken}` },
      });
      expect(withServerRes.statusCode).toBe(200);
      expect(JSON.parse(withServerRes.body)).toEqual({ serverUuids: [server.id] });
    } finally {
      await prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.deleteMany({ where: { id: server.id } }));
      await prisma.user.updateMany({ where: { id: owner.id }, data: { deletedAt: new Date() } });
    }
  });

  it('rejects the servers list without a node token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/remote/nodes/servers' });
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

  /**
   * `servers.power_state` had NO writer at any point in the codebase: it
   * sat at its `'offline'` schema default forever while containers ran,
   * so the panel showed every server as offline and a version change's
   * "must be offline" precondition could never reject anything. The
   * heartbeat is now that writer — these pin down the four properties it
   * has to hold.
   */
  describe('per-server power state', () => {
    let ownerId: string;
    let serverA: string;
    let serverB: string;
    let otherNodeId: string;
    let foreignServer: string;
    // Its own token, not the outer `nodeToken`: the re-bootstrap test
    // above deliberately revokes that one, so reusing it here would 401
    // on every request and prove nothing about power state.
    let token: string;

    const asAdmin = <T>(fn: (tx: Parameters<Parameters<PrismaService['withRLS']>[1]>[0]) => Promise<T>) =>
      prisma.withRLS({ userId: null, isAdmin: true }, fn);

    // `setup_pending` purely to satisfy the `servers_setup_consistency`
    // check without dragging a template/plan fixture into this suite:
    // that constraint ties `status` to template_id/docker_image/
    // startup_command, none of which the heartbeat's power-state writer
    // reads or branches on. Status is an orthogonal axis to powerState
    // here — see status-labels.ts's own note on the two.
    const makeServer = (shortId: string, node: string, name: string) =>
      asAdmin((tx) =>
        tx.server.create({
          data: { shortId, ownerId, nodeId: node, name, memoryMb: 1024, diskMb: 5120, status: 'setup_pending' },
          select: { id: true },
        }),
      ).then((s) => s.id);

    const powerStateOf = (id: string) =>
      asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id }, select: { powerState: true, powerStateAt: true } }));

    beforeAll(async () => {
      const owner = await prisma.user.findFirstOrThrow({ where: { email: `nodes-admin-${suffix}@gxhost.local` }, select: { id: true } });
      ownerId = owner.id;

      const bootstrapToken = JSON.parse((await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' })).body).token;
      const redeemed = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/bootstrap',
        payload: { token: bootstrapToken, hostname: 'e2e-power-state-host', os: 'linux', kernel: '6.1.0', dockerVersion: '27.0.0', arch: 'amd64' },
      });
      token = JSON.parse(redeemed.body).nodeToken;

      const other = await prisma.node.create({
        data: { locationId, name: `nodes-e2e-other-${suffix}`, fqdn: `other-${suffix}.e2e.local`, memoryTotalMb: 8192, diskTotalMb: 102400 },
        select: { id: true },
      });
      otherNodeId = other.id;

      serverA = await makeServer(`ps${String(suffix).slice(-6)}`, nodeId, 'power-state A');
      serverB = await makeServer(`pt${String(suffix).slice(-6)}`, nodeId, 'power-state B');
      foreignServer = await makeServer(`pu${String(suffix).slice(-6)}`, otherNodeId, 'power-state foreign');
    });

    afterAll(async () => {
      await asAdmin((tx) => tx.server.deleteMany({ where: { id: { in: [serverA, serverB, foreignServer] } } }));
      await prisma.node.deleteMany({ where: { id: otherNodeId } });
    });

    it('a heartbeat carrying server states writes them to power_state', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { servers: [{ uuid: serverA, state: 'running' }, { uuid: serverB, state: 'crashed' }] },
      });
      expect(res.statusCode).toBe(201);

      expect((await powerStateOf(serverA)).powerState).toBe('running');
      expect((await powerStateOf(serverB)).powerState).toBe('crashed');
    });

    it('a server the payload OMITS keeps its state — an absent entry means "no news", never offline', async () => {
      // Exactly what the agent sends while a server is busy with a Docker
      // call (srv.Manager.States skips it rather than blocking). Treating
      // that gap as "offline" would flap the panel on every start/stop.
      const res = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { servers: [{ uuid: serverA, state: 'running' }] },
      });
      expect(res.statusCode).toBe(201);
      expect((await powerStateOf(serverB)).powerState).toBe('crashed');
    });

    it('an old agent that sends no `servers` key at all leaves every state untouched', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { agentVersion: 'v0.4.0-e2e-old-agent' },
      });
      expect(res.statusCode).toBe(201);
      expect((await powerStateOf(serverA)).powerState).toBe('running');
      expect((await powerStateOf(serverB)).powerState).toBe('crashed');
    });

    it('power_state_at only moves when the state actually CHANGES', async () => {
      // What makes the column answer "offline since when?" instead of
      // "when did the last heartbeat arrive?" — every 15s tick re-reports
      // the same state, so an unconditional write would destroy it.
      const before = await powerStateOf(serverA);
      await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { servers: [{ uuid: serverA, state: 'running' }] },
      });
      const unchanged = await powerStateOf(serverA);
      expect(unchanged.powerStateAt.getTime()).toBe(before.powerStateAt.getTime());

      await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { servers: [{ uuid: serverA, state: 'offline' }] },
      });
      const changed = await powerStateOf(serverA);
      expect(changed.powerState).toBe('offline');
      expect(changed.powerStateAt.getTime()).toBeGreaterThan(before.powerStateAt.getTime());
    });

    it('a node cannot rewrite the power state of a server hosted on a DIFFERENT node', async () => {
      // The security property: a node speaks only for what it hosts.
      // Without the nodeId scope, one compromised or merely misconfigured
      // agent could rewrite every server on the platform.
      const res = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { servers: [{ uuid: foreignServer, state: 'running' }] },
      });
      expect(res.statusCode).toBe(201); // silently ignored, never an error the agent could probe with
      expect((await powerStateOf(foreignServer)).powerState).toBe('offline');
    });

    // Rejecting an out-of-range state value is asserted in
    // src/modules/nodes/dto/node.dto.spec.ts instead of here: this suite
    // builds its app with Test.createTestingModule and never installs
    // main.ts's global ValidationPipe, so no DTO validation runs at all
    // in it — an expectation of 400 here would be testing the test
    // harness, not the contract.
  });

  /**
   * Reconciliation used to run in ONE direction: the agent tore down a
   * container with no matching server, but nothing noticed a server whose
   * container was gone. It sat in `installing` forever while every
   * operation on it answered SERVER_NOT_FOUND. These pin down the rules
   * the panel applies, including the two it must NOT apply.
   */
  describe('node inventory reconciliation', () => {
    let ownerId: string;
    let token: string;
    const made: string[] = [];

    const asAdmin = <T>(fn: (tx: Parameters<Parameters<PrismaService['withRLS']>[1]>[0]) => Promise<T>) =>
      prisma.withRLS({ userId: null, isAdmin: true }, fn);

    // `updatedAt` is @updatedAt, so Prisma overwrites any value passed on
    // create — it has to be forced afterwards with raw SQL. Every case
    // here depends on the row being OLDER than the grace window, which is
    // exactly what stops a freshly-dispatched server being condemned.
    async function makeServer(status: string, ageMinutes: number): Promise<string> {
      const shortId = Math.random().toString(36).slice(2, 10);
      const id = await asAdmin((tx) =>
        tx.server.create({
          data: { shortId, ownerId, nodeId, name: `inv-${shortId}`, memoryMb: 1024, diskMb: 5120, status: 'setup_pending' },
          select: { id: true },
        }),
      ).then((s) => s.id);
      await asAdmin((tx) =>
        tx.$executeRaw`UPDATE servers SET status = ${status}, updated_at = NOW() - (${ageMinutes} * INTERVAL '1 minute') WHERE id = ${id}::uuid`,
      );
      made.push(id);
      return id;
    }

    const statusOf = (id: string) =>
      asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id }, select: { status: true } })).then((s) => s.status);

    const report = (uuids: string[]) =>
      app.inject({
        method: 'POST',
        url: '/api/remote/nodes/servers/inventory',
        headers: { authorization: `Bearer ${token}` },
        payload: { serverUuids: uuids },
      });

    beforeAll(async () => {
      const owner = await prisma.user.findFirstOrThrow({ where: { email: `nodes-admin-${suffix}@gxhost.local` }, select: { id: true } });
      ownerId = owner.id;
      const bt = JSON.parse((await authed(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' })).body).token;
      const redeemed = await app.inject({
        method: 'POST',
        url: '/api/remote/nodes/bootstrap',
        payload: { token: bt, hostname: 'e2e-inventory-host' },
      });
      token = JSON.parse(redeemed.body).nodeToken;
    });

    afterAll(async () => {
      await asAdmin((tx) => tx.server.deleteMany({ where: { id: { in: made } } }));
    });

    it('moves a stuck `installing` server the node does not have to install_failed', async () => {
      const stuck = await makeServer('installing', 60);
      const res = await report([]);
      expect(res.statusCode).toBe(201);
      expect(await statusOf(stuck)).toBe('install_failed');
    });

    it('leaves a server the node DOES report alone', async () => {
      const healthy = await makeServer('installing', 60);
      await report([healthy]);
      expect(await statusOf(healthy)).toBe('installing');
    });

    /**
     * The race this window exists for: the API's create call and the
     * agent's Register are not atomic, so a server dispatched moments ago
     * is legitimately absent. Condemning it would break every new server.
     */
    it('never touches a server younger than the grace window', async () => {
      const fresh = await makeServer('installing', 1);
      await report([]);
      expect(await statusOf(fresh)).toBe('installing');
    });

    /** `setup_pending` has no container BY DESIGN — no template chosen yet. */
    it('never touches a setup_pending server', async () => {
      const pending = await makeServer('setup_pending', 60);
      await report([]);
      expect(await statusOf(pending)).toBe('setup_pending');
    });

    /**
     * A `ready` server whose container vanished is broken too, but its
     * world data is on disk and the fix is recreating a container, not
     * re-running an install. Rewriting the status would erase that
     * distinction, so it is reported and audited, never mutated.
     */
    it('flags but does NOT rewrite a ready server that went missing', async () => {
      const ready = await makeServer('ready', 60);
      const res = await report([]);
      expect(JSON.parse(res.body).flagged).toBeGreaterThan(0);
      expect(await statusOf(ready)).toBe('ready');
    });

    it('rejects an inventory report with no node token', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/remote/nodes/servers/inventory', payload: { serverUuids: [] } });
      expect(res.statusCode).toBe(401);
    });
  });
});
