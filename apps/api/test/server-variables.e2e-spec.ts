import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { ServersService } from '../src/modules/servers/servers.service';

/**
 * Regression coverage for a real bug found live: `ServerVariablesService`'s
 * `list()` and `update()` both read `server_variables` through a BARE
 * `this.prisma.serverVariable.findMany(...)` — never `withRLS`. That table
 * carries the same RLS policy `servers` does (PrismaService.withRLS's own
 * doc comment: "even one already authorized by a guard ... MUST go through
 * this"), so with `app.user_id` never set, every one of those queries
 * silently matched ZERO rows. Two distinct, compounding symptoms, both only
 * ever needed a REAL Postgres with RLS active to surface — no unit test
 * (mocked Prisma) could ever have caught this, which is exactly why this
 * file exists instead:
 *
 *  1. `list()` always fell through to `tv.defaultValue` for every
 *     variable, never the customer's real stored value — invisible for a
 *     field whose real value happens to equal its default, very visible
 *     the moment it doesn't (a customer's actual installed
 *     `MINECRAFT_VERSION` showing the template's CURRENT default instead).
 *  2. `update()`'s own read of "every OTHER declared variable's current
 *     value" (to carry forward into the agent payload/DB write untouched)
 *     hit the exact same empty-map bug — so saving ANY one field silently
 *     RESET every other declared variable back to its template default,
 *     both in the container recreate payload sent to the agent and in the
 *     row written back to `server_variables`.
 */
describe('Server variables (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let servers: ServersService;
  let ownerToken: string;
  let ownerId: string;
  let locationId: string;
  let nodeId: string;
  let planId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  const suffix = Date.now();

  function asAdmin(fn: (tx: any) => Promise<any>): Promise<any> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }

  // A real (fake) HTTP agent, not the un-bootstrapped-node/503 convention
  // most e2e files default to — this bug can only be observed once
  // `complete()`'s dispatch genuinely succeeds and the server reaches
  // `ready`, since `list`/`update` both short-circuit long before that
  // for a `setup_pending` row.
  let fakeAgent: http.Server;
  let nodeToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    servers = app.get(ServersService);

    const passwordHash = await argon2.hash('VarsE2ePass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const owner = await prisma.user.create({
      data: { email: `vars-owner-${suffix}@gxhost.local`, username: `vars-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'VarsE2ePass!234567' } });
    ownerToken = JSON.parse(ownerLogin.body).accessToken;

    fakeAgent = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/servers') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'installing' }));
        return;
      }
      if (req.method === 'PATCH' && req.url?.endsWith('/variables')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.8', resolve)); // .8 — next free loopback after server-setup.e2e-spec's .1-.7
    const port = (fakeAgent.address() as AddressInfo).port;

    await prisma.node.updateMany({ where: { fqdn: '127.0.0.8', deletedAt: null }, data: { deletedAt: new Date() } });
    const loc = await prisma.location.create({ data: { shortCode: `vars-e2e-${suffix}`, name: 'Server Variables E2E' } });
    locationId = loc.id;
    const node = await prisma.node.create({
      data: { locationId, name: `vars-e2e-node-${suffix}`, fqdn: '127.0.0.8', scheme: 'http', daemonPort: port, memoryTotalMb: 4096, diskTotalMb: 40960 },
    });
    nodeId = node.id;

    const passwordHashAdmin = await argon2.hash('VarsE2ePass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `vars-admin-${suffix}@gxhost.local`, username: `vars-admin-${suffix}`, passwordHash: passwordHashAdmin, globalRole: 'admin', isActive: true },
    });
    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'VarsE2ePass!234567' } });
    const adminToken = JSON.parse(adminLogin.body).accessToken;

    await app.inject({
      method: 'POST',
      url: `/api/admin/nodes/${nodeId}/allocations`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: '203.0.115.30', startPort: 27800, endPort: 27800 },
    });
    const tokenRes = await app.inject({ method: 'POST', url: `/api/admin/nodes/${nodeId}/bootstrap-token`, headers: { authorization: `Bearer ${adminToken}` } });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'vars-e2e-host' } });
    nodeToken = JSON.parse(bootstrapRes.body).nodeToken;

    const plan = await prisma.plan.create({
      data: { name: `vars-e2e-plan-${suffix}`, slug: `vars-e2e-plan-${suffix}`, memoryMb: 1024, diskMb: 4096, cpuLimitPercent: 150, priceCents: 4990, isPublic: true },
    });
    planId = plan.id;

    const group = await prisma.templateGroup.create({ data: { name: `vars-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId: group.id,
        name: `vars-e2e-template-${suffix}`,
        author: 'test',
        dockerImages: { x: 'y' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        isActive: true,
        isPublic: true,
        variables: {
          create: [
            {
              name: 'Minecraft Version',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'v1',
              rules: 'required|string|max:16|in:v1,v2',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
            {
              name: 'Server Jar File',
              envVariable: 'SERVER_JARFILE',
              defaultValue: 'server.jar',
              rules: 'required|string|max:64',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 1,
            },
          ],
        },
      },
    });
    templateId = template.id;

    const created = await servers.createSetupPending({ ownerId, planId, nodeId });
    serverId = created.id;
    const setupRes = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      // MINECRAFT_VERSION is deliberately set to the NON-default curated
      // choice ('v2', not 'v1') — this is what makes the list() bug
      // observable at all: a value equal to its own default can't tell a
      // real read apart from a silent fallback.
      payload: { name: 'vars-e2e-server', templateId, variables: { MINECRAFT_VERSION: 'v2' } },
    });
    expect(setupRes.statusCode).toBe(201);

    const installCompletedRes = await app.inject({
      method: 'POST',
      url: `/api/remote/servers/${serverId}/install-completed`,
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { successful: true },
    });
    expect(installCompletedRes.statusCode).toBe(201);
  }, 20000);

  afterAll(async () => {
    const cleanupSteps: Array<() => Promise<unknown>> = [
      () => asAdmin((tx) => tx.allocation.updateMany({ where: { nodeId }, data: { isPrimary: false, serverId: null } })),
      () => asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } })),
      () => prisma.templateVariable.deleteMany({ where: { templateId } }),
      () => prisma.serverTemplate.deleteMany({ where: { id: templateId } }),
      () => prisma.templateGroup.deleteMany({ where: { id: groupId } }),
      () => prisma.plan.updateMany({ where: { id: planId }, data: { deletedAt: new Date() } }),
      () => prisma.node.deleteMany({ where: { id: nodeId } }),
      () => prisma.location.deleteMany({ where: { id: locationId } }),
      () => prisma.user.updateMany({ where: { email: { contains: 'vars-' } }, data: { deletedAt: new Date() } }),
    ];
    for (const step of cleanupSteps) {
      await step().catch((err) => console.error('server-variables.e2e-spec afterAll step failed (continuing):', err));
    }
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('GET .../variables returns the customer\'s REAL saved value, not the template\'s current default', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/variables`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ envVariable: string; value: string; defaultValue: string }>;

    const mcVersion = body.find((v) => v.envVariable === 'MINECRAFT_VERSION');
    expect(mcVersion?.defaultValue).toBe('v1'); // the template's own default, unchanged
    expect(mcVersion?.value).toBe('v2'); // what this server actually installed — the bug returned 'v1' here

    const jarFile = body.find((v) => v.envVariable === 'SERVER_JARFILE');
    expect(jarFile?.value).toBe('server.jar'); // never explicitly set — correctly falls back to its own default
  });

  it('PATCH .../variables updates only the given field(s) and never resets an untouched one back to its template default', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/variables`, {
      method: 'PATCH',
      payload: { values: { SERVER_JARFILE: 'custom.jar' } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ envVariable: string; value: string }>;

    expect(body.find((v) => v.envVariable === 'SERVER_JARFILE')?.value).toBe('custom.jar'); // the field actually edited
    // The regression this test exists for: MINECRAFT_VERSION was never
    // touched by this PATCH, so it must still read 'v2' — the bug reset
    // it to the template's default ('v1') as a side effect of ANY save.
    expect(body.find((v) => v.envVariable === 'MINECRAFT_VERSION')?.value).toBe('v2');

    // Confirms the fix all the way down to the row itself, not just this
    // response body (which `update()` builds by calling `list()` again).
    const row = await asAdmin((tx) =>
      tx.serverVariable.findFirst({ where: { serverId, variable: { envVariable: 'MINECRAFT_VERSION' } } }),
    );
    expect(row.value).toBe('v2');
  });
});
