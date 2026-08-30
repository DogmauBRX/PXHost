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
