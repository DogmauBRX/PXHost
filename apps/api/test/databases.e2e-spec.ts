import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as mysql from 'mysql2/promise';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * M9 (Databases): a real MariaDB container (docker-compose.dev.yml's
 * `mariadb` service) stands in for an admin-registered "database host" —
 * the whole point of this milestone is that the panel connects DIRECTLY
 * to it (never through the Node Agent) to provision a real schema+user, so
 * mocking that connection would prove nothing about the actual DoD:
 * "plugin connects with created credentials; server deletion drops the
 * schema+user." Both are asserted here by actually connecting with the
 * generated credentials via a second, independent `mysql2` connection —
 * the same thing a game plugin would do.
 */
describe('Databases (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let ownerToken: string;
  let intruderToken: string;
  let ownerId: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  let hostId: string;
  const suffix = Date.now();

  const MARIADB_HOST = '127.0.0.1';
  const MARIADB_PORT = 3306;
  const MARIADB_ROOT_PASSWORD = 'pxhost_dbhost_dev';

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }
  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function asIntruder(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${intruderToken}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('DbsPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `dbs-admin-${suffix}@pxhost.local`, username: `dbs-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const owner = await prisma.user.create({
      data: { email: `dbs-owner-${suffix}@pxhost.local`, username: `dbs-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const intruder = await prisma.user.create({
      data: { email: `dbs-intruder-${suffix}@pxhost.local`, username: `dbs-intruder-${suffix}`, passwordHash, isActive: true },
    });

    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'DbsPass!234567' } })).body).accessToken;
    ownerToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'DbsPass!234567' } })).body).accessToken;
    intruderToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: intruder.email, password: 'DbsPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `dbs-e2e-${suffix}`, name: 'Databases E2E' } });
    locationId = loc.id;
    const node = await prisma.node.create({
      data: { locationId, name: `dbs-e2e-node-${suffix}`, fqdn: `dbs-e2e-node-${suffix}.test`, scheme: 'http', daemonPort: 29544, memoryTotalMb: 4096, diskTotalMb: 40960 },
    });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.119.10', startPort: 27950, endPort: 27950 } });

    const group = await prisma.templateGroup.create({ data: { name: `dbs-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: { groupId, name: 'dbs-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' },
    });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', {
      method: 'POST',
      payload: { name: `dbs-e2e-plan-${suffix}`, slug: `dbs-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512, maxDatabases: 2 },
    });
    const planId = JSON.parse(planRes.body).id;

    const createRes = await authedAdmin('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId, templateId, planId, name: 'dbs-e2e server' } });
    serverId = JSON.parse(createRes.body).id;

    const hostRes = await authedAdmin('/api/admin/database-hosts', {
      method: 'POST',
      payload: { name: `dbs-e2e-host-${suffix}`, host: MARIADB_HOST, port: MARIADB_PORT, username: 'root', password: MARIADB_ROOT_PASSWORD, maxDatabases: 100 },
    });
    expect(hostRes.statusCode).toBe(201);
    hostId = JSON.parse(hostRes.body).id;
  });

  afterAll(async () => {
    // Real MySQL-side cleanup FIRST — deleting the Postgres rows doesn't
    // touch the real schema+user on the mariadb container, and this
    // suite reuses the same shared dev host across runs.
    const root = await mysql.createConnection({ host: MARIADB_HOST, port: MARIADB_PORT, user: 'root', password: MARIADB_ROOT_PASSWORD });
    const leftoverDbs = await asAdmin<{ database: string; username: string; remote: string }[]>((tx) => tx.database.findMany({ where: { hostId } }));
    for (const db of leftoverDbs) {
      await root.query(`DROP DATABASE IF EXISTS \`${db.database}\``).catch(() => undefined);
      await root.query(`DROP USER IF EXISTS ?@?`, [db.username, db.remote]).catch(() => undefined);
    }
    await root.end();

    await asAdmin((tx) => tx.database.deleteMany({ where: { hostId } }));
    await prisma.databaseHost.deleteMany({ where: { id: hostId } });
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({
      where: { email: { in: [`dbs-admin-${suffix}@pxhost.local`, `dbs-owner-${suffix}@pxhost.local`, `dbs-intruder-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  it('a non-owner gets 404 on every databases route', async () => {
    const base = `/api/client/servers/${serverId}/databases`;
    expect((await asIntruder(base)).statusCode).toBe(404);
    expect((await asIntruder(base, { method: 'POST', payload: {} })).statusCode).toBe(404);
  });

  let firstDbId: string;
  let firstDbPassword: string;
  let firstDbUsername: string;
  let firstDbName: string;

  it('creates a real MySQL database+user, and a real client can connect with the returned credentials', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/databases`, { method: 'POST', payload: { name: 'plugin_data' } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.database).toMatch(/^s[a-z0-9]+_plugin_data$/);
    expect(body.password).toBeTruthy();
    firstDbId = body.id;
    firstDbPassword = body.password;
    firstDbUsername = body.username;
    firstDbName = body.database;

    // The DoD, proven literally: connect as the credentials a game
    // plugin would actually receive, not as root.
    const conn = await mysql.createConnection({ host: MARIADB_HOST, port: MARIADB_PORT, user: firstDbUsername, password: firstDbPassword, database: firstDbName });
    await conn.query('CREATE TABLE t (id INT)');
    await conn.query('INSERT INTO t VALUES (1)');
    const [rows] = await conn.query('SELECT * FROM t');
    expect(rows).toEqual([{ id: 1 }]);
    await conn.end();
  });

  it('lists the created database without ever exposing the password', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/databases`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(firstDbId);
    expect(body[0].password).toBeUndefined();
  });

  it('enforces the plan\'s maxDatabases quota (2 on this plan)', async () => {
    const second = await asOwner(`/api/client/servers/${serverId}/databases`, { method: 'POST', payload: { name: 'second' } });
    expect(second.statusCode).toBe(201);

    const third = await asOwner(`/api/client/servers/${serverId}/databases`, { method: 'POST', payload: { name: 'third' } });
    expect(third.statusCode).toBe(409);
  });

  it('deleting a database actually drops the real schema+user — the same credentials can no longer connect', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/databases/${firstDbId}`, { method: 'DELETE' });
    expect(res.statusCode).toBe(204);

    await expect(
      mysql.createConnection({ host: MARIADB_HOST, port: MARIADB_PORT, user: firstDbUsername, password: firstDbPassword, database: firstDbName }),
    ).rejects.toThrow();
  });

  it('deleting a server drops every remaining database it owns on the real host', async () => {
    // A second, throwaway server + a fake agent standing in for the Node
    // Agent's real DELETE /api/servers/:uuid — this suite's node is
    // otherwise unreachable by design (a `.test` fqdn), which is exactly
    // right for every OTHER test here, but server deletion legitimately
    // needs a live agent to confirm teardown before anything else
    // happens (ServersService.remove — "hard-deleted once the agent
    // confirms teardown" is not negotiable).
    const fakeAgent = http.createServer((req, res) => {
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address per test file (127.0.0.1 for backups,
    // .2 here, .3 for schedules, .4 for subusers) — fqdn carries a real
    // partial-unique index on lower(fqdn), and Jest runs different spec
    // files in parallel worker processes, so two files both racing to
    // claim '127.0.0.1' at once (soft-delete-then-create isn't atomic
    // across processes) intermittently failed the loser's node.create()
    // with a real unique-constraint violation. Found live running the
    // full suite after adding subusers.e2e-spec.ts as a fourth claimant.
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.2', resolve));
    try {
      const port = (fakeAgent.address() as AddressInfo).port;
      // fqdn carries a real partial-unique index (WHERE deleted_at IS
      // NULL) on lower(fqdn) — see backups.e2e-spec.ts's identical note.
      await prisma.node.updateMany({ where: { fqdn: '127.0.0.2', deletedAt: null }, data: { deletedAt: new Date() } });
      const delNode = await prisma.node.create({
        data: { locationId, name: `dbs-e2e-delnode-${suffix}`, fqdn: '127.0.0.2', scheme: 'http', daemonPort: port, memoryTotalMb: 4096, diskTotalMb: 40960 },
      });
      try {
        await authedAdmin(`/api/admin/nodes/${delNode.id}/allocations`, { method: 'POST', payload: { ip: '203.0.120.10', startPort: 27960, endPort: 27960 } });
        // AgentClient decrypts controlTokenEnc for every call — without a
        // real bootstrap, DELETE /api/admin/servers/:id fails at the
        // agent.deleteServer() step before ever reaching database
        // cleanup, which is what actually happened the first time this
        // test was written and run (503, not the 204 it now asserts).
        const tokenRes = await authedAdmin(`/api/admin/nodes/${delNode.id}/bootstrap-token`, { method: 'POST' });
        const bootstrapToken = JSON.parse(tokenRes.body).token;
        const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'dbs-e2e-delnode-host' } });
        expect(bootstrapRes.statusCode).toBe(201);

        const planRes = await authedAdmin('/api/admin/plans', {
          method: 'POST',
          payload: { name: `dbs-e2e-delplan-${suffix}`, slug: `dbs-e2e-delplan-${suffix}`, memoryMb: 256, diskMb: 512, maxDatabases: 5 },
        });
        const planId = JSON.parse(planRes.body).id;
        const createRes = await authedAdmin('/api/admin/servers', { method: 'POST', payload: { ownerId, nodeId: delNode.id, templateId, planId, name: 'dbs-e2e delserver' } });
        const delServerId = JSON.parse(createRes.body).id;

        const dbRes = await asOwner(`/api/client/servers/${delServerId}/databases`, { method: 'POST', payload: { name: 'to_be_dropped' } });
        expect(dbRes.statusCode).toBe(201);
        const { database: droppedDbName } = JSON.parse(dbRes.body);

        const beforeCount = await asAdmin<number>((tx) => tx.database.count({ where: { hostId } }));

        const removeRes = await authedAdmin(`/api/admin/servers/${delServerId}`, { method: 'DELETE' });
        expect(removeRes.statusCode).toBe(204);

        const afterCount = await asAdmin<number>((tx) => tx.database.count({ where: { hostId } }));
        expect(afterCount).toBe(beforeCount - 1);

        // Not just the metadata row — the real schema on the real host.
        const root = await mysql.createConnection({ host: MARIADB_HOST, port: MARIADB_PORT, user: 'root', password: MARIADB_ROOT_PASSWORD });
        const [dbs] = await root.query('SHOW DATABASES LIKE ?', [droppedDbName]);
        expect(dbs).toHaveLength(0);
        await root.end();

        const serverRow = await asAdmin((tx) => tx.server.findFirst({ where: { id: delServerId } }));
        expect(serverRow).toBeNull();
      } finally {
        await asAdmin((tx) => tx.allocation.updateMany({ where: { nodeId: delNode.id }, data: { isPrimary: false, serverId: null } }));
        await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId: delNode.id } }));
        await prisma.node.deleteMany({ where: { id: delNode.id } });
      }
    } finally {
      await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    }
  });

  it('admin database-host CRUD: cannot delete a host that still has databases in use', async () => {
    const inUse = await authedAdmin(`/api/admin/database-hosts/${hostId}`, { method: 'DELETE' });
    expect(inUse.statusCode).toBe(409);
  });

  it('registering a host with bad credentials fails fast, at registration time', async () => {
    const res = await authedAdmin('/api/admin/database-hosts', {
      method: 'POST',
      payload: { name: `dbs-e2e-badhost-${suffix}`, host: MARIADB_HOST, port: MARIADB_PORT, username: 'root', password: 'definitely-wrong', maxDatabases: 10 },
    });
    expect(res.statusCode).toBe(503);
  });
});
