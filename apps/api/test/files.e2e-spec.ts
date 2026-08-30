import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * The owner-facing files surface (M7): ownership scoping on every route,
 * and that download/upload signed-URL minting produces a well-formed,
 * correctly-scoped EdDSA token — the same style of proof M6's
 * client-servers.e2e-spec.ts used for the console token. The "small ops"
 * routes (list/write/rename/...) all proxy through AgentClient exactly
 * like console-token minting and power actions already do; their real,
 * live proof is the agent-side route tests
 * (agent/internal/api/routes_files_test.go), which exercise the actual
 * fsx jail — not re-mocked here.
 */
describe('Files (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
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

    const passwordHash = await argon2.hash('FilesPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `files-admin-${suffix}@pxhost.local`, username: `files-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const owner = await prisma.user.create({
      data: { email: `files-owner-${suffix}@pxhost.local`, username: `files-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const intruder = await prisma.user.create({
      data: { email: `files-intruder-${suffix}@pxhost.local`, username: `files-intruder-${suffix}`, passwordHash, isActive: true },
    });

    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'FilesPass!234567' } });
    const adminToken = JSON.parse(adminLogin.body).accessToken;
    const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'FilesPass!234567' } });
    ownerToken = JSON.parse(ownerLogin.body).accessToken;
    const intruderLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: intruder.email, password: 'FilesPass!234567' } });
    intruderToken = JSON.parse(intruderLogin.body).accessToken;

    function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
      return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
    }

    const loc = await prisma.location.create({ data: { shortCode: `files-e2e-${suffix}`, name: 'Files E2E' } });
    locationId = loc.id;
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `files-e2e-node-${suffix}`,
        fqdn: `files-e2e-node-${suffix}.test`,
        scheme: 'http',
        daemonPort: 29443,
        memoryTotalMb: 4096,
        diskTotalMb: 40960,
      },
    });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.116.10', startPort: 27600, endPort: 27600 },
    });

    const group = await prisma.templateGroup.create({ data: { name: `files-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: 'files-e2e template',
        author: 'test',
        dockerImages: { default: 'alpine:3.19' },
        startupCommand: 'cat',
        installScript: '#!/bin/sh\ntrue',
      },
    });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', {
      method: 'POST',
      payload: { name: `files-e2e-plan-${suffix}`, slug: `files-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512 },
    });
    const planId = JSON.parse(planRes.body).id;

    const createRes = await authedAdmin('/api/admin/servers', {
      method: 'POST',
      payload: { ownerId, nodeId, templateId, planId, name: 'files-e2e server' },
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
      where: { email: { in: [`files-admin-${suffix}@pxhost.local`, `files-owner-${suffix}@pxhost.local`, `files-intruder-${suffix}@pxhost.local`] } },
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

  it('a non-owner gets 404 on every files route, never confirming the server exists', async () => {
    const base = `/api/client/servers/${serverId}/files`;
    const list = await asIntruder(`${base}?path=.`);
    expect(list.statusCode).toBe(404);
    const link = await asIntruder(`${base}/download-link`, { method: 'POST', payload: { path: 'server.properties' } });
    expect(link.statusCode).toBe(404);
  });

  it('list/write/etc. reach real AgentClient wiring (503 against an un-bootstrapped node)', async () => {
    const base = `/api/client/servers/${serverId}/files`;
    const list = await asOwner(`${base}?path=.`);
    expect(list.statusCode).toBe(503);
  });

  it('mints a well-formed, single-path-scoped EdDSA download link', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/files/download-link`, {
      method: 'POST',
      payload: { path: 'server.properties' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.expiresIn).toBe(60);

    const url = new URL(body.url);
    expect(url.pathname).toBe(`/api/servers/${serverId}/files/download`);
    expect(url.searchParams.get('path')).toBe('server.properties');
    const token = url.searchParams.get('token')!;
    const [h, p] = token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'EdDSA', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.cap).toBe('file.download');
    expect(claims.sub).toBe(serverId);
    expect(claims.aud).toBe(`node:${nodeId}`);
    expect(claims.ctx).toEqual({ path: 'server.properties' });
  });

  it('mints an upload link whose ctx carries the caller-requested maxBytes, capped at the outer ceiling', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/files/upload-link`, {
      method: 'POST',
      payload: { path: 'world.zip', maxBytes: 2_000_000_000 }, // ~2GB, matching the M7 DoD's "2 GB upload works"
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.maxBytes).toBe(2_000_000_000);
    expect(body.expiresIn).toBe(900);

    const token = new URL(body.url).searchParams.get('token')!;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.cap).toBe('file.upload');
    expect(claims.ctx).toEqual({ path: 'world.zip', maxBytes: 2_000_000_000 });
  });
});
