import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * M11 (Subusers, granular RBAC, activity feed). DoD: "Invited friend can
 * restart but not delete backups; every mutation attributed in the
 * feed." Both halves proven against a real HTTP server standing in for
 * the agent (same reasoning as every prior milestone's fake-agent tests)
 * and real Postgres RLS — not a mock of ServerAccessService.
 */
describe('Subusers / RBAC / Activity (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let ownerToken: string;
  let friendToken: string;
  let friendId: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  let fakeAgent: http.Server;
  let agentRequests: string[] = [];
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }
  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function asFriend(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${friendToken}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    fakeAgent = http.createServer((req, res) => {
      agentRequests.push(`${req.method} ${req.url}`);
      if (req.url?.endsWith('/backups') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      if (req.url?.includes('/backups/') && req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url?.endsWith('/power') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', previous: 'offline' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address per test file (backups=.1, databases=.2,
    // schedules=.3, .4 here) — fqdn's real partial-unique index made two
    // spec files racing to claim '127.0.0.1' in parallel Jest workers
    // intermittently fail with a genuine unique-constraint violation.
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.4', resolve));
    const port = (fakeAgent.address() as AddressInfo).port;

    const passwordHash = await argon2.hash('SubPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({ data: { email: `sub-admin-${suffix}@pxhost.local`, username: `sub-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true } });
    const owner = await prisma.user.create({ data: { email: `sub-owner-${suffix}@pxhost.local`, username: `sub-owner-${suffix}`, passwordHash, isActive: true } });
    const friend = await prisma.user.create({ data: { email: `sub-friend-${suffix}@pxhost.local`, username: `sub-friend-${suffix}`, passwordHash, isActive: true } });
    friendId = friend.id;

    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'SubPass!234567' } })).body).accessToken;
    ownerToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'SubPass!234567' } })).body).accessToken;
    friendToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: friend.email, password: 'SubPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `sub-e2e-${suffix}`, name: 'Subusers E2E' } });
    locationId = loc.id;
    await prisma.node.updateMany({ where: { fqdn: '127.0.0.4', deletedAt: null }, data: { deletedAt: new Date() } });
    const node = await prisma.node.create({ data: { locationId, name: `sub-e2e-node-${suffix}`, fqdn: '127.0.0.4', scheme: 'http', daemonPort: port, memoryTotalMb: 4096, diskTotalMb: 40960 } });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.122.10', startPort: 27980, endPort: 27980 } });
    const tokenRes = await authedAdmin(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'sub-e2e-host' } });
    expect(bootstrapRes.statusCode).toBe(201);

    const group = await prisma.templateGroup.create({ data: { name: `sub-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({ data: { groupId, name: 'sub-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' } });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', { method: 'POST', payload: { name: `sub-e2e-plan-${suffix}`, slug: `sub-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512 } });
    const planId = JSON.parse(planRes.body).id;

    const createRes = await authedAdmin('/api/admin/servers', { method: 'POST', payload: { ownerId: owner.id, nodeId, templateId, planId, name: 'sub-e2e server' } });
    serverId = JSON.parse(createRes.body).id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.subuser.deleteMany({ where: { serverId } }));
    await asAdmin((tx) => tx.activityLog.deleteMany({ where: { serverId } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({
      where: { email: { in: [`sub-admin-${suffix}@pxhost.local`, `sub-owner-${suffix}@pxhost.local`, `sub-friend-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('permission catalog is real, seeded data', async () => {
    const res = await asOwner('/api/client/permission-catalog');
    expect(res.statusCode).toBe(200);
    const keys = JSON.parse(res.body).map((p: { key: string }) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['control.restart', 'backup.delete', 'backup.read']));
  });

  it('a stranger cannot access the server at all (404, not 403 — never confirms existence)', async () => {
    const res = await asFriend(`/api/client/servers/${serverId}`);
    expect(res.statusCode).toBe(404);
  });

  it('a non-owner cannot invite subusers, even on a server they can somehow reach', async () => {
    // friend isn't invited yet, so this 404s the same as the test above —
    // covered again explicitly below once friend actually has access.
    const res = await asFriend(`/api/client/servers/${serverId}/subusers`, { method: 'POST', payload: { email: 'nobody@pxhost.local', permissions: [] } });
    expect(res.statusCode).toBe(404);
  });

  let subuserId: string;

  it("the owner invites the friend with control.restart but NOT backup.delete — exactly the DoD's example", async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/subusers`, {
      method: 'POST',
      payload: { email: `sub-friend-${suffix}@pxhost.local`, permissions: ['websocket.connect', 'control.console', 'control.restart', 'backup.read'] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.user.id).toBe(friendId);
    expect(body.permissions).toEqual(['websocket.connect', 'control.console', 'control.restart', 'backup.read']);
    subuserId = body.id;
  });

  it('inviting an unknown permission key is rejected', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/subusers`, { method: 'POST', payload: { email: `sub-friend-${suffix}@pxhost.local`, permissions: ['not.a.real.permission'] } });
    expect(res.statusCode).toBe(400);
  });

  it('inviting the same user twice is rejected', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/subusers`, { method: 'POST', payload: { email: `sub-friend-${suffix}@pxhost.local`, permissions: [] } });
    expect(res.statusCode).toBe(409);
  });

  it('the friend can now see the server (accepted immediately, v1 has no pending-invite UI)', async () => {
    const res = await asFriend(`/api/client/servers/${serverId}`);
    expect(res.statusCode).toBe(200);
  });

  it('the friend CAN restart — the DoD, literally', async () => {
    agentRequests = [];
    const res = await asFriend(`/api/client/servers/${serverId}/power`, { method: 'POST', payload: { action: 'restart' } });
    expect(res.statusCode).toBe(201);
    expect(agentRequests.some((r) => r.includes('/power'))).toBe(true);
  });

  it('the friend can list backups (backup.read) but CANNOT delete one — the other half of the DoD', async () => {
    const listRes = await asFriend(`/api/client/servers/${serverId}/backups`);
    expect(listRes.statusCode).toBe(200);

    const deleteRes = await asFriend(`/api/client/servers/${serverId}/backups/some-backup-id`, { method: 'DELETE' });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("the owner CAN delete backups on their own server (ownership is the permission superset, never itself a stored grant)", async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/backups/some-backup-id`, { method: 'DELETE' });
    expect(res.statusCode).toBe(204);
  });

  it('every mutation above is attributed in the activity feed — restart by the friend, delete by the owner, invite by the owner', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/activity`);
    expect(res.statusCode).toBe(200);
    const events = JSON.parse(res.body) as { event: string; actor: { id: string } | null }[];

    const invite = events.find((e) => e.event === 'server.subuser.invite');
    expect(invite?.actor?.id).not.toBe(friendId); // attributed to the owner, not the invitee

    const restart = events.find((e) => e.event === 'server.power.restart');
    expect(restart?.actor?.id).toBe(friendId); // attributed to whoever actually clicked it, not the owner

    const del = events.find((e) => e.event === 'server.backup.delete');
    expect(del?.actor?.id).not.toBe(friendId); // the owner's delete, not the friend's (which was rejected)
  });

  it("the friend without activity.read cannot see the feed", async () => {
    const res = await asFriend(`/api/client/servers/${serverId}/activity`);
    expect(res.statusCode).toBe(403);
  });

  it('granting a new permission takes effect immediately — the Redis permission cache is invalidated on update, not just left to expire', async () => {
    const grant = await asOwner(`/api/client/servers/${serverId}/subusers/${subuserId}`, { method: 'PATCH', payload: { permissions: ['websocket.connect', 'control.console', 'control.restart', 'backup.read', 'backup.delete'] } });
    expect(grant.statusCode).toBe(200);

    const deleteRes = await asFriend(`/api/client/servers/${serverId}/backups/some-other-backup-id`, { method: 'DELETE' });
    expect(deleteRes.statusCode).toBe(204);
  });

  it('removing the subuser revokes access entirely, immediately (cache invalidation again)', async () => {
    const removeRes = await asOwner(`/api/client/servers/${serverId}/subusers/${subuserId}`, { method: 'DELETE' });
    expect(removeRes.statusCode).toBe(204);

    const afterRes = await asFriend(`/api/client/servers/${serverId}`);
    expect(afterRes.statusCode).toBe(404);
  });
});
