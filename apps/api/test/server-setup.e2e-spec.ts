import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { ServersService } from '../src/modules/servers/servers.service';
import { CapacityService } from '../src/modules/capacity/capacity.service';
import { PublicTemplatesService } from '../src/modules/public/public-templates.service';
import { RedisService } from '../src/core/redis/redis.service';

/**
 * The post-purchase setup flow (see the setup plan): a `setup_pending`
 * server is created directly via `ServersService.createSetupPending` —
 * bypassing checkout/payment entirely, same "call the service the
 * webhook/worker itself calls" convention `provisioning.e2e-spec.ts`
 * already established — since this file is about what happens AFTER
 * provisioning, not provisioning itself.
 *
 * The node fixture is deliberately never bootstrapped (no
 * `control_token_enc`, same as `client-servers.e2e-spec.ts`'s power
 * test) — `AgentClient` then refuses every dispatch with a clean 503
 * with NO real network I/O (`baseURL` throws before ever reaching
 * `fetch`), which is exactly what makes the retry-after-failure tests
 * below deterministic instead of racy against a real agent.
 */
describe('Server setup (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let servers: ServersService;
  let capacity: CapacityService;
  let ownerToken: string;
  let intruderToken: string;
  let ownerId: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let planId: string;
  let templateId: string;
  let privateTemplateId: string;
  let inactiveTemplateId: string;
  let staleDefaultTemplateId: string;
  let uncuratedTemplateId: string;
  let adminToken: string;
  const suffix = Date.now();

  function asAdmin(fn: (tx: any) => Promise<any>): Promise<any> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function asIntruder(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${intruderToken}` }, ...opts });
  }
  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    servers = app.get(ServersService);
    capacity = app.get(CapacityService);

    const passwordHash = await argon2.hash('SetupPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `setup-admin-${suffix}@gxhost.local`, username: `setup-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const owner = await prisma.user.create({
      data: { email: `setup-owner-${suffix}@gxhost.local`, username: `setup-owner-${suffix}`, passwordHash, isActive: true },
    });
    ownerId = owner.id;
    const intruder = await prisma.user.create({
      data: { email: `setup-intruder-${suffix}@gxhost.local`, username: `setup-intruder-${suffix}`, passwordHash, isActive: true },
    });

    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'SetupPass!234567' } });
    adminToken = JSON.parse(adminLogin.body).accessToken;
    const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'SetupPass!234567' } });
    ownerToken = JSON.parse(ownerLogin.body).accessToken;
    const intruderLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: intruder.email, password: 'SetupPass!234567' } });
    intruderToken = JSON.parse(intruderLogin.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `setup-e2e-${suffix}`, name: 'Server Setup E2E' } });
    locationId = loc.id;
    // Deliberately never bootstrapped (no control_token_enc) — see this
    // file's own doc comment for why that's what makes the dispatch
    // failure/retry tests below deterministic.
    const node = await prisma.node.create({
      data: {
        locationId,
        name: `setup-e2e-node-${suffix}`,
        fqdn: `setup-e2e-node-${suffix}.test`,
        scheme: 'http',
        daemonPort: 28443,
        memoryTotalMb: 8192,
        diskTotalMb: 102400,
      },
    });
    nodeId = node.id;
    // Enough allocations for every server this file creates (main +
    // retry reuses the SAME allocation + one for the permission-gate
    // server + two for the subscription-attach race).
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.0.115.10', startPort: 27600, endPort: 27610 },
    });

    const plan = await prisma.plan.create({
      data: { name: `setup-e2e-plan-${suffix}`, slug: `setup-e2e-plan-${suffix}`, memoryMb: 1024, diskMb: 4096, cpuLimitPercent: 150, priceCents: 4990, isPublic: true },
    });
    planId = plan.id;

    const group = await prisma.templateGroup.create({ data: { name: `setup-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `setup-e2e-paper-${suffix}`,
        author: 'test',
        description: 'Paper — rápido e compatível com plugins',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        softwareKind: 'paper',
        isActive: true,
        isPublic: true,
        variables: {
          create: [
            {
              name: 'Minecraft Version',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: '1.21.4',
              rules: 'required|string|max:16|in:1.21.4,1.21.1,1.20.6',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
            {
              name: 'Server Memory',
              envVariable: 'SERVER_MEMORY',
              defaultValue: '1024',
              rules: 'required|integer|min:512',
              isUserViewable: true,
              isUserEditable: false,
              sortOrder: 1,
            },
          ],
        },
      },
    });
    templateId = template.id;
    const privateTemplate = await prisma.serverTemplate.create({
      data: { groupId, name: `setup-e2e-private-${suffix}`, author: 'test', dockerImages: { x: 'y' }, startupCommand: 'x', installScript: 'x', isActive: true, isPublic: false },
    });
    privateTemplateId = privateTemplate.id;
    const inactiveTemplate = await prisma.serverTemplate.create({
      data: { groupId, name: `setup-e2e-inactive-${suffix}`, author: 'test', dockerImages: { x: 'y' }, startupCommand: 'x', installScript: 'x', isActive: false, isPublic: true },
    });
    inactiveTemplateId = inactiveTemplate.id;
    // Reproduces the real production incident: a template whose
    // MINECRAFT_VERSION `rules` were curated to an `in:<list>` but whose
    // `defaultValue` was left at the pre-curation "latest" sentinel
    // (software-presets.ts's own free-text default) — no longer a legal
    // value once curated. `getSetupInfo` must never hand this stale value
    // to the client as the pre-selected version.
    const staleDefaultTemplate = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `setup-e2e-stale-default-${suffix}`,
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        softwareKind: 'vanilla',
        isActive: true,
        isPublic: true,
        variables: {
          create: [
            {
              name: 'Minecraft Version',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'latest',
              rules: 'required|string|max:16|in:1.21.4,1.21.1,1.20.6',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
          ],
        },
      },
    });
    staleDefaultTemplateId = staleDefaultTemplate.id;

    // A fresh "criação rápida" preset template, exactly as software-presets.ts
    // seeds it — MINECRAFT_VERSION starts free-text (`rules` with no
    // `in:`), never curated by an admin. Proves GET .../setup still hands
    // the client a real dropdown by falling back to SoftwareDiscoveryService.
    const uncuratedTemplate = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `setup-e2e-uncurated-fabric-${suffix}`,
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        softwareKind: 'fabric',
        isActive: true,
        isPublic: true,
        variables: {
          create: [
            {
              name: 'Minecraft Version',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'latest',
              rules: 'required|string|max:16',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
          ],
        },
      },
    });
    uncuratedTemplateId = uncuratedTemplate.id;

    // PublicTemplatesService.list() caches in Redis for 60s, SHARED with
    // every other e2e file hitting the public templates endpoint in a
    // parallel Jest worker — without this, a GET .../setup run moments
    // after another file's request could see a stale cached catalog that
    // predates the templates just created above.
    await app.get(PublicTemplatesService).invalidateCache();
  });

  afterAll(async () => {
    // Each step independently caught (checkout.e2e-spec.ts's own
    // `cleanupSteps` convention) — found live: a single failing step
    // (the FK-violating `serverTemplate.deleteMany` below, when a server
    // from a Jest-timed-out test elsewhere in this file still referenced
    // one of these templates) used to abort every step after it,
    // leaving the template rows — `isPublic: true` on the Paper one —
    // live in the REAL client-facing setup catalog until manually
    // found and removed. One slow/timed-out test must never leak
    // customer-visible data because cleanup gave up partway through.
    const cleanupSteps: Array<() => Promise<unknown>> = [
      () => asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } })),
      () => asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } })),
      // Defensive, not redundant: catches a server left behind on some
      // OTHER (e.g. a test's own temporary bootstrapped) node that still
      // points at one of these template ids — exactly what happened
      // live. Deleting by templateId here, before the template rows
      // themselves, is what makes the FK-violation scenario above
      // impossible to repeat.
      () =>
        asAdmin((tx) =>
          tx.server.deleteMany({
            where: { templateId: { in: [templateId, privateTemplateId, inactiveTemplateId, staleDefaultTemplateId, uncuratedTemplateId] } },
          }),
        ),
      () => asAdmin((tx) => tx.subscription.deleteMany({ where: { planId } })),
      () => prisma.plan.updateMany({ where: { id: planId }, data: { deletedAt: new Date() } }),
      () => prisma.templateVariable.deleteMany({ where: { templateId: { in: [templateId, staleDefaultTemplateId, uncuratedTemplateId] } } }),
      () =>
        prisma.serverTemplate.deleteMany({
          where: { id: { in: [templateId, privateTemplateId, inactiveTemplateId, staleDefaultTemplateId, uncuratedTemplateId] } },
        }),
      () => prisma.templateGroup.deleteMany({ where: { id: groupId } }),
      () => prisma.node.deleteMany({ where: { id: nodeId } }),
      () => prisma.location.deleteMany({ where: { id: locationId } }),
      () => prisma.user.updateMany({ where: { email: { contains: 'setup-' } }, data: { deletedAt: new Date() } }),
      () => app.get(PublicTemplatesService).invalidateCache(),
    ];
    for (const step of cleanupSteps) {
      await step().catch((err) => console.error('server-setup.e2e-spec afterAll step failed (continuing):', err));
    }
    await app.close();
  });

  let serverId: string;

  it('createSetupPending reserves the plan slot and the node\'s RAM/disk immediately, and never dispatches to the agent', async () => {
    const before = await asAdmin((tx) => capacity.usageForNode(tx, nodeId));
    const beforeSlots = await asAdmin((tx) => capacity.occupiedSlots(tx, planId));

    const created = await servers.createSetupPending({ ownerId, planId, nodeId });
    serverId = created.id;
    expect(created.status).toBe('setup_pending');

    const after = await asAdmin((tx) => capacity.usageForNode(tx, nodeId));
    const afterSlots = await asAdmin((tx) => capacity.occupiedSlots(tx, planId));
    // The plan's own numbers, reserved the instant the row exists —
    // stopped, unconfigured, no container at all.
    expect(after.memoryMb - before.memoryMb).toBe(1024);
    expect(after.diskMb - before.diskMb).toBe(4096);
    expect(afterSlots - beforeSlots).toBe(1);

    // Zero agent calls — the entire reason CPU/RAM stay at zero until
    // setup completes. If ServersService.createOnNode ever dispatched
    // for a `null` templateContext, this un-bootstrapped node would have
    // produced a `server.create.dispatch_failed` audit row by now.
    const dispatchAudits = await asAdmin((tx) =>
      tx.auditLog.findMany({ where: { targetType: 'server', targetId: serverId, action: { startsWith: 'server.create.dispatch' } } }),
    );
    expect(dispatchAudits).toHaveLength(0);
  });

  it('GET .../setup returns the plan\'s own resources and only the public+active template catalog, with MINECRAFT_VERSION exposed as a curated version list', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('setup_pending');
    expect(body.plan).toEqual({ memoryMb: 1024, diskMb: 4096, cpuLimitPercent: 150 });

    const entry = body.software.find((s: any) => s.id === templateId);
    expect(entry).toBeTruthy();
    expect(entry.versionsCurated).toBe(true);
    expect(entry.versions).toEqual(['1.21.4', '1.21.1', '1.20.6']);
    expect(entry.defaultVersion).toBe('1.21.4');
    expect(entry.softwareKind).toBe('paper');
    // Never the private/inactive templates, and never a technical field
    // (SERVER_JARFILE/PAPER_BUILD/Docker image/etc.) anywhere in the body.
    expect(body.software.some((s: any) => s.id === privateTemplateId)).toBe(false);
    expect(body.software.some((s: any) => s.id === inactiveTemplateId)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('docker');
    expect(JSON.stringify(body)).not.toContain('SERVER_MEMORY');
  });

  it('GET .../setup falls back to the first curated version when a template\'s stored default has drifted out of its own in: list', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`);
    const body = JSON.parse(res.body);
    const entry = body.software.find((s: any) => s.id === staleDefaultTemplateId);
    expect(entry).toBeTruthy();
    expect(entry.versionsCurated).toBe(true);
    expect(entry.versions).toEqual(['1.21.4', '1.21.1', '1.20.6']);
    // NOT 'latest' (the stale stored value) — a value the customer could
    // actually submit successfully without touching the dropdown.
    expect(entry.defaultVersion).toBe('1.21.4');
  });

  it('GET .../setup falls back to live SoftwareDiscoveryService when a template has no curated in: list yet', async () => {
    // Forces a fresh fetch instead of a hit from whatever the same Redis
    // instance already cached for "fabric" from a real, earlier run.
    await app.get(RedisService).client.del('template-discovery:fabric:versions');
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => [
        { version: '1.21.4', stable: true },
        { version: '1.21.1', stable: true },
        { version: '1.20.6', stable: false }, // non-stable entries are filtered out
      ],
    } as any);

    try {
      const res = await asOwner(`/api/client/servers/${serverId}/setup`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const entry = body.software.find((s: any) => s.id === uncuratedTemplateId);
      expect(entry).toBeTruthy();
      expect(entry.versionsCurated).toBe(true);
      expect(entry.versions).toEqual(['1.21.4', '1.21.1']);
      // NOT 'latest' (the template's own free-text default) — a value
      // the customer could actually submit and have it validate.
      expect(entry.defaultVersion).toBe('1.21.4');
      expect(fetchSpy).toHaveBeenCalledWith('https://meta.fabricmc.net/v2/versions/game', expect.anything());
    } finally {
      fetchSpy.mockRestore();
      await app.get(RedisService).client.del('template-discovery:fabric:versions');
    }
  });

  it('GET .../setup 404s for a non-owner (never confirms existence)', async () => {
    const res = await asIntruder(`/api/client/servers/${serverId}/setup`);
    expect(res.statusCode).toBe(404);
  });

  it('POST .../setup 404s on a template id that does not exist', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor', templateId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST .../setup 404s on a template that is not public', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor', templateId: privateTemplateId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST .../setup 404s on a template that is not active', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor', templateId: inactiveTemplateId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST .../setup rejects a version outside the template\'s own in: list', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor', templateId, variables: { MINECRAFT_VERSION: '1.16.5' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST .../setup rejects the client overriding a non-editable variable (SERVER_MEMORY stays plan-controlled)', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor', templateId, variables: { SERVER_MEMORY: '999999' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST .../setup with valid input resolves the technical config, writes it to the row, and (since the node was never bootstrapped) surfaces the dispatch failure as a real error instead of a false success', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor-paper', templateId, variables: { MINECRAFT_VERSION: '1.21.1' } },
    });
    // rethrow: true (ServerSetupService.complete) — unlike the admin
    // create path, a customer's setup call must see the real error.
    expect(res.statusCode).toBe(503);

    const server = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: serverId } }));
    expect(server.name).toBe('meu-servidor-paper');
    expect(server.templateId).toBe(templateId);
    expect(server.dockerImage).toBe('ghcr.io/pxhost/yolks:java_21');
    expect(server.startupCommand).toBe('java -jar server.jar');
    // The CAS wrote 'installing' before dispatch; dispatchToAgent's own
    // failure handling is what moved it on to 'install_failed' — never
    // stuck at 'installing' with no explanation.
    expect(server.status).toBe('install_failed');

    const vars = await asAdmin((tx) =>
      tx.serverVariable.findMany({ where: { serverId }, include: { variable: true } }),
    );
    const byEnvVar = Object.fromEntries(vars.map((v: any) => [v.variable.envVariable, v.value]));
    expect(byEnvVar.MINECRAFT_VERSION).toBe('1.21.1'); // the customer's real choice
    expect(byEnvVar.SERVER_MEMORY).toBe('1024'); // the template's own default — never the '999999' rejected two tests ago
  });

  it('the client can retry after install_failed — same server, same uid, same allocation, never a duplicate', async () => {
    const before = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: serverId } }));
    const beforeAllocationCount = await asAdmin((tx) => tx.allocation.count({ where: { serverId } }));
    const beforeServerCount = await asAdmin((tx) => tx.server.count({ where: { ownerId, nodeId } }));

    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'meu-servidor-paper', templateId, variables: { MINECRAFT_VERSION: '1.21.1' } },
    });
    expect(res.statusCode).toBe(503); // the agent is still unreachable — same failure, not a new one

    const after = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: serverId } }));
    expect(after.id).toBe(before.id);
    expect(after.uid).toBe(before.uid);
    expect(after.status).toBe('install_failed');

    const afterAllocationCount = await asAdmin((tx) => tx.allocation.count({ where: { serverId } }));
    const afterServerCount = await asAdmin((tx) => tx.server.count({ where: { ownerId, nodeId } }));
    expect(afterAllocationCount).toBe(beforeAllocationCount); // never re-picked
    expect(afterServerCount).toBe(beforeServerCount); // never a second server
  });

  it('POST .../setup refuses once the server has moved past setup (INVALID_TRANSITION, not a silent re-install)', async () => {
    // Simulates a completed install without needing a real agent —
    // reportInstallResult (the agent's own callback) is what would set
    // this in production; the CAS's predicate is what's under test here.
    await asAdmin((tx) => tx.server.update({ where: { id: serverId }, data: { status: 'ready', installedAt: new Date() } }));

    const res = await asOwner(`/api/client/servers/${serverId}/setup`, {
      method: 'POST',
      payload: { name: 'outro-nome', templateId, variables: { MINECRAFT_VERSION: '1.21.1' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('INVALID_TRANSITION');

    const server = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: serverId } }));
    expect(server.name).not.toBe('outro-nome'); // the rejected request never wrote anything
    expect(server.status).toBe('ready');
  });

  it('a setup_pending server blocks power/console actions (deny-by-default pre-ready gate) — not the agent-unreachable 503 a ready server would get', async () => {
    const pending = await servers.createSetupPending({ ownerId, planId, nodeId });

    const powerRes = await asOwner(`/api/client/servers/${pending.id}/power`, { method: 'POST', payload: { action: 'start' } });
    expect(powerRes.statusCode).toBe(403);
    expect(powerRes.body).toContain('Missing permission');

    // mintConsoleToken never throws on insufficient permissions — it mints
    // a token either way, embedding only whatever `can()` grants (same
    // posture as a suspended server's token, per that method's own doc
    // comment). For setup_pending, none of WS_PERMISSION_KEYS end in
    // `.read`, so the token comes back with an EMPTY permissions list —
    // unable to even open the console socket, without a 403 here.
    const consoleRes = await asOwner(`/api/client/servers/${pending.id}/console-token`, { method: 'POST' });
    expect(consoleRes.statusCode).toBe(201);
    expect(JSON.parse(consoleRes.body).token).toBeTruthy();
    const claims = JSON.parse(Buffer.from(JSON.parse(consoleRes.body).token.split('.')[1], 'base64url').toString());
    expect(claims.permissions).toEqual([]);

    // `.read` permissions still pass — the setup screen itself depends on this.
    const getRes = await asOwner(`/api/client/servers/${pending.id}`);
    expect(getRes.statusCode).toBe(200);
  });

  it('one subscription can never end up attached to two servers (SUBSCRIPTION_ALREADY_HAS_SERVER)', async () => {
    const plan = await asAdmin((tx) => tx.plan.findUniqueOrThrow({ where: { id: planId } }));
    // `subscriptions` carries the same RLS policy `servers` does — a bare
    // `prisma.subscription.create(...)` with no app.user_id/app.is_admin
    // set gets rejected outright (42501), not silently scoped. Must go
    // through `withRLS`, same as every other write in this file.
    const subscription = await asAdmin((tx) =>
      tx.subscription.create({
        data: { userId: ownerId, planId, priceCents: plan.priceCents, currency: plan.currency, billingPeriod: plan.billingPeriod },
      }),
    );

    const first = await servers.createSetupPending({ ownerId, planId, nodeId, attachSubscriptionId: subscription.id });
    const firstServer = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: first.id } }));
    expect(firstServer.status).toBe('setup_pending');

    await expect(servers.createSetupPending({ ownerId, planId, nodeId, attachSubscriptionId: subscription.id })).rejects.toThrow(/SUBSCRIPTION_ALREADY_HAS_SERVER/);

    // The rejected attempt rolled back its own transaction entirely — no
    // orphaned second server or consumed allocation left behind.
    const subAfter = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } }));
    expect(subAfter.serverId).toBe(first.id); // still points at the FIRST server, never overwritten
    const serversForThisSubscription = await asAdmin((tx) => tx.server.count({ where: { subscription: { id: subscription.id } } }));
    expect(serversForThisSubscription).toBe(1);
  });

  // The only test in this file against a BOOTSTRAPPED node with a real
  // (fake) HTTP agent behind it — every other test above deliberately
  // uses the un-bootstrapped shared node so dispatch fails deterministically
  // (see this file's own top doc comment). This one instead proves the
  // FULL happy path the rest of the suite only ever gets partway through:
  // setup_pending -> POST /setup (agent accepts) -> installing ->
  // install-completed callback -> ready -> POST /power -> running.
  it('the full happy path reaches ready and running: setup succeeds, install-completed flips it to ready, and the owner can start it', async () => {
    const fakeAgent = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/servers') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'installing' }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/power')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', previous: 'offline' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.6', resolve));
    try {
      const port = (fakeAgent.address() as AddressInfo).port;
      // Distinct loopback address per e2e file, same convention
      // backups(.1)/databases(.2)/schedules(.3)/subusers(.4)/plans-
      // apply(.5)/plan-apply-capacity(.7) already established — fqdn
      // carries a real partial-unique index (WHERE deleted_at IS NULL).
      await prisma.node.updateMany({ where: { fqdn: '127.0.0.6', deletedAt: null }, data: { deletedAt: new Date() } });
      const loc = await prisma.location.create({ data: { shortCode: `setup-e2e-happy-${suffix}`, name: 'Server Setup Happy Path E2E' } });
      const node = await prisma.node.create({
        data: {
          locationId: loc.id,
          name: `setup-e2e-happy-node-${suffix}`,
          fqdn: '127.0.0.6',
          scheme: 'http',
          daemonPort: port,
          memoryTotalMb: 4096,
          diskTotalMb: 40960,
        },
      });
      try {
        await authedAdmin(`/api/admin/nodes/${node.id}/allocations`, {
          method: 'POST',
          payload: { ip: '203.0.115.20', startPort: 27700, endPort: 27700 },
        });
        const tokenRes = await authedAdmin(`/api/admin/nodes/${node.id}/bootstrap-token`, { method: 'POST' });
        const bootstrapToken = JSON.parse(tokenRes.body).token;
        const bootstrapRes = await app.inject({
          method: 'POST',
          url: '/api/remote/nodes/bootstrap',
          payload: { token: bootstrapToken, hostname: 'setup-e2e-happy-host' },
        });
        expect(bootstrapRes.statusCode).toBe(201);
        const nodeToken = JSON.parse(bootstrapRes.body).nodeToken;

        const created = await servers.createSetupPending({ ownerId, planId, nodeId: node.id });
        expect(created.status).toBe('setup_pending');

        const setupRes = await asOwner(`/api/client/servers/${created.id}/setup`, {
          method: 'POST',
          payload: { name: 'servidor-feliz', templateId, variables: { MINECRAFT_VERSION: '1.21.1' } },
        });
        // The agent accepted the create this time — no dispatch failure,
        // so this is a real success, not the 503 the rest of the file's
        // un-bootstrapped node always produces.
        expect(setupRes.statusCode).toBe(201);
        expect(JSON.parse(setupRes.body).status).toBe('installing');

        const installingServer = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: created.id } }));
        expect(installingServer.status).toBe('installing');

        // The agent's own callback — reportInstallResult has no status
        // precondition, so this is the sole authority on reaching 'ready',
        // exactly like a real install finishing would trigger it.
        const installCompletedRes = await app.inject({
          method: 'POST',
          url: `/api/remote/servers/${created.id}/install-completed`,
          headers: { authorization: `Bearer ${nodeToken}` },
          payload: { successful: true },
        });
        expect(installCompletedRes.statusCode).toBe(201);

        const readyServer = await asAdmin((tx) => tx.server.findUniqueOrThrow({ where: { id: created.id } }));
        expect(readyServer.status).toBe('ready');
        expect(readyServer.installedAt).not.toBeNull();

        // 'ready' is no longer a pre-ready status — allowedForStatus stops
        // denying control.start the instant setup_pending is behind it,
        // and the fake agent's own /power handler is what proves this
        // reaches a real dispatch, not just a permission check passing.
        const powerRes = await asOwner(`/api/client/servers/${created.id}/power`, { method: 'POST', payload: { action: 'start' } });
        expect(powerRes.statusCode).toBe(201); // ClientServersController's @Post has no @HttpCode override — Nest's own POST default
        expect(JSON.parse(powerRes.body).state).toBe('running');
      } finally {
        await asAdmin((tx) => tx.allocation.updateMany({ where: { nodeId: node.id }, data: { isPrimary: false, serverId: null } }));
        await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId: node.id } }));
        await prisma.node.deleteMany({ where: { id: node.id } });
        await prisma.location.deleteMany({ where: { id: loc.id } });
      }
    } finally {
      // `.close()` alone waits for every open connection to end on its
      // own — a keep-alive socket AgentClient's `fetch()` left idle after
      // the last request would otherwise stall this indefinitely (found
      // live: a run of this exact test hung for hours instead of the
      // usual few seconds). `closeAllConnections()` (Node 18.2+) forces
      // them shut immediately; safe here since every request this test
      // makes has already completed by this point.
      fakeAgent.closeAllConnections();
      await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    }
    // Explicit timeout, above Jest's 5000ms default: this test makes ~7
    // sequential HTTP round-trips (allocations, bootstrap-token,
    // bootstrap, createSetupPending, POST /setup, install-completed,
    // POST /power), each through the full Nest pipeline + Prisma — under
    // the full suite's parallel-worker load this occasionally exceeded
    // 5000ms and hit Jest's timeout. That failure mode is exactly what
    // caused the FK-violation/leaked-template incident this file's
    // afterAll now also guards against — a slow test must fail with a
    // clear "exceeded timeout," never abort mid-cleanup.
  }, 15000);
});
