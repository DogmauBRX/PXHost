import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * The owner-facing backups surface (M8): ownership scoping, and that a
 * download link is minted with the right capability/ctx shape — same
 * proof style as M7's files.e2e-spec.ts. The real backup mechanics
 * (streaming tar.gz, ignore patterns, dry-run restore validation,
 * tar-slip protection, atomic swap) are proven where they actually live:
 * agent/internal/backup and agent/internal/srv's own test suites,
 * against a real Linux kernel — not re-mocked here.
 */
describe('Backups (e2e)', () => {
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
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('BackupsPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `backups-admin-${suffix}@pxhost.local`, username: `backups-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const owner = await prisma.user.create({
      data: { email: `backups-owner-${suffix}@pxhost.local`, username: `backups-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const intruder = await prisma.user.create({
      data: { email: `backups-intruder-${suffix}@pxhost.local`, username: `backups-intruder-${suffix}`, passwordHash, isActive: true },
    });

    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'BackupsPass!234567' } });
    adminToken = JSON.parse(adminLogin.body).accessToken;
    const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'BackupsPass!234567' } });
    ownerToken = JSON.parse(ownerLogin.body).accessToken;
    const intruderLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: intruder.email, password: 'BackupsPass!234567' } });
    intruderToken = JSON.parse(intruderLogin.body).accessToken;

    function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
      return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
    }

    const loc = await prisma.location.create({ data: { shortCode: `backups-e2e-${suffix}`, name: 'Backups E2E' } });
    locationId = loc.id;
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `backups-e2e-node-${suffix}`,
        fqdn: `backups-e2e-node-${suffix}.test`,
        scheme: 'http',
        daemonPort: 29543,
        memoryTotalMb: 4096,
        diskTotalMb: 40960,
      },
    });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.117.10', startPort: 27800, endPort: 27800 },
    });

    const group = await prisma.templateGroup.create({ data: { name: `backups-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'backups-e2e template',
        author: 'test',
        dockerImages: { default: 'alpine:3.19' },
        startupCommand: 'cat',
        installScript: '#!/bin/sh\ntrue',
      },
    });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', {
      method: 'POST',
      payload: { name: `backups-e2e-plan-${suffix}`, slug: `backups-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512 },
    });
    const planId = JSON.parse(planRes.body).id;

    const createRes = await authedAdmin('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'backups-e2e server' },
    });
    serverId = JSON.parse(createRes.body).id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({
      where: { email: { in: [`backups-admin-${suffix}@pxhost.local`, `backups-owner-${suffix}@pxhost.local`, `backups-intruder-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function asIntruder(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${intruderToken}` }, ...opts });
  }

  it('a non-owner gets 404 on every backups route', async () => {
    const base = `/api/client/servers/${serverId}/backups`;
    expect((await asIntruder(base)).statusCode).toBe(404);
    expect((await asIntruder(base, { method: 'POST', payload: {} })).statusCode).toBe(404);
    expect((await asIntruder(`${base}/some-id/download-link`, { method: 'POST' })).statusCode).toBe(404);
  });

  it('list/create reach real AgentClient wiring (503 against an un-bootstrapped node)', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/backups`, { method: 'POST', payload: {} });
    expect(res.statusCode).toBe(503);
  });

  // Found live (M8 manual verification): a real agent's 409 ("server must
  // be stopped before restore") was being collapsed into a generic 503 by
  // AgentClient.call, so the panel's "servidor precisa estar parado"
  // message never rendered — the raw agent error text showed instead.
  // Regression-covers the fix in agent-client.service.ts (409 passthrough)
  // against a real HTTP server standing in for the agent, since the
  // Go agent's own SERVER_NOT_STOPPED->409 mapping is already covered by
  // agent/internal/api/routes_backups_test.go.
  it('surfaces the agent\'s 409 (server not stopped) as 409, not a generic 503', async () => {
    const fakeAgent = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/restore')) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'SERVER_NOT_STOPPED', message: 'srv: server must be stopped before restore (current state: running)' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.1', resolve));
    // Everything from here on must be reachable by the outer finally, or a
    // failure partway through setup leaks the listening socket — that's
    // exactly what left the first version of this test hanging after a
    // FAILED run ("Jest did not exit ... asynchronous operations that
    // weren't stopped"), found live while writing this same test.
    try {
      function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
        return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
      }

      // fqdn carries a real, partial-unique (WHERE deleted_at IS NULL)
      // index on lower(fqdn) — literal '127.0.0.1' only, not scoped by
      // port, so at most one non-deleted node in the whole database can
      // ever use it. Soft-delete any prior claimant first so this test is
      // re-runnable without manual DB cleanup in between.
      await prisma.node.updateMany({ where: { fqdn: '127.0.0.1', deletedAt: null }, data: { deletedAt: new Date() } });

      const port = (fakeAgent.address() as AddressInfo).port;
      const loc = await prisma.location.create({ data: { shortCode: `backups-409-e2e-${suffix}`, name: 'Backups 409 E2E' } });
      const node = await prisma.node.create({
        data: {
          locationId: loc.id,
          name: `backups-409-e2e-node-${suffix}`,
          fqdn: '127.0.0.1',
          scheme: 'http',
          daemonPort: port,
          memoryTotalMb: 4096,
          diskTotalMb: 40960,
        },
      });
      try {
        await authedAdmin(`/api/admin/nodes/${node.id}/allocations`, {
          method: 'POST',
          payload: { ip: '203.0.118.10', startPort: 27900, endPort: 27900 },
        });
        const tokenRes = await authedAdmin(`/api/admin/nodes/${node.id}/bootstrap-token`, { method: 'POST' });
        const bootstrapToken = JSON.parse(tokenRes.body).token;
        const bootstrapRes = await app.inject({
          method: 'POST',
          url: '/api/remote/nodes/bootstrap',
          payload: { token: bootstrapToken, hostname: 'backups-409-e2e-host' },
        });
        expect(bootstrapRes.statusCode).toBe(201);

        const planRes = await authedAdmin('/api/admin/plans', {
          method: 'POST',
          payload: { name: `backups-409-e2e-plan-${suffix}`, slug: `backups-409-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512 },
        });
        const planId = JSON.parse(planRes.body).id;
        const createRes = await authedAdmin('/api/admin/servers', {
          method: 'POST',
          payload: { ownerId, nodeId: node.id, templateId, planId, name: 'backups-409-e2e server' },
        });
        const fakeServerId = JSON.parse(createRes.body).id;

        const res = await asOwner(`/api/client/servers/${fakeServerId}/backups/some-backup-id/restore`, { method: 'POST' });
        expect(res.statusCode).toBe(409);
        expect(res.body).toContain('SERVER_NOT_STOPPED');
      } finally {
        await asAdmin((tx) => tx.allocation.updateMany({ where: { nodeId: node.id }, data: { isPrimary: false, serverId: null } }));
        await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId: node.id } }));
        await prisma.node.deleteMany({ where: { id: node.id } });
        await prisma.location.deleteMany({ where: { id: loc.id } });
      }
    } finally {
      await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    }
  });

  it('mints a well-formed EdDSA backup-download token scoped to the backup id, only for the owner', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/backups/some-backup-id/download-link`, { method: 'POST' });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.expiresIn).toBe(60);

    const url = new URL(body.url);
    expect(url.pathname).toBe(`/api/servers/${serverId}/backups/some-backup-id/download`);
    const token = url.searchParams.get('token')!;
    const [h, p] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'JWT' });
    expect(typeof header.kid).toBe('string'); // roadmap M13: every minted token names which JWKS key verifies it
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.cap).toBe('backup.download');
    expect(claims.sub).toBe(serverId);
    expect(claims.aud).toBe(`node:${nodeId}`);
    expect(claims.ctx).toEqual({ path: 'some-backup-id' });

    const intruderRes = await asIntruder(`/api/client/servers/${serverId}/backups/some-backup-id/download-link`, { method: 'POST' });
    expect(intruderRes.statusCode).toBe(404);
  });
});
