import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { ServerAccessService } from '../src/modules/authorization/server-access.service';

/**
 * The single most important test in this milestone: proves Row-Level
 * Security actually restricts access at the DATABASE level, not just in
 * application code (architecture doc 2.4 / M3 DoD: "RLS proven by a query
 * as a non-owner returning 0 rows").
 *
 * The test deliberately does NOT go through ServerAccessService for the
 * negative case — it runs a raw query as app_user with a non-owner's
 * app.user_id set, bypassing the application layer entirely, to prove the
 * database itself is the enforcement point. If someone deletes every
 * `WHERE owner_id = ?` in the codebase tomorrow, this test still passes
 * or fails on the database's own say-so.
 *
 * Fixture setup below writes to RLS-enabled tables (servers, subusers,
 * backups) through `withRLS({ isAdmin: true }, ...)` rather than the bare
 * connection. This isn't a test-only workaround — it's the same real
 * mechanism admin-surface application code will use once it exists: since
 * the WHOLE API connects as `app_user` (a non-owner role, always subject
 * to RLS — see PrismaService's doc comment), there is no separate
 * "superuser bypass" connection anywhere, by design. A bare
 * `prisma.server.create()` outside any RLS context correctly gets
 * rejected by the `servers` table's `WITH CHECK` policy — that rejection
 * is itself proof the policy is doing its job on writes, not just reads.
 */
describe('Row-Level Security (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let access: ServerAccessService;

  let ownerId: string;
  let intruderId: string;
  let serverId: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;

  const asAdmin = <T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>) =>
    prisma.withRLS({ userId: null, isAdmin: true }, fn);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    prisma = app.get(PrismaService);
    access = app.get(ServerAccessService);

    const suffix = Date.now();
    // users, locations, nodes, template_groups, server_templates carry no
    // RLS policy (architecture doc 2.4 scopes RLS to server-owned tables
    // only — see the README's "bugs found" note), so these writes work
    // through the plain app_user connection same as production code.
    const owner = await prisma.user.create({
      data: { email: `rls-owner-${suffix}@pxhost.local`, username: `rls-owner-${suffix}`, passwordHash: 'x', isActive: true },
    });
    const intruder = await prisma.user.create({
      data: { email: `rls-intruder-${suffix}@pxhost.local`, username: `rls-intruder-${suffix}`, passwordHash: 'x', isActive: true },
    });
    ownerId = owner.id;
    intruderId = intruder.id;

    const location = await prisma.location.create({ data: { shortCode: `rls-${suffix}`, name: 'RLS Test Location' } });
    locationId = location.id;
    const node = await prisma.node.create({
      data: { locationId: location.id, name: `rls-node-${suffix}`, fqdn: `rls-${suffix}.test`, memoryTotalMb: 1024, diskTotalMb: 1024 },
    });
    nodeId = node.id;
    const group = await prisma.templateGroup.create({ data: { name: `rls-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId: group.id,
        name: `rls-template-${suffix}`,
        author: 'test',
        dockerImages: { default: 'alpine' },
        startupCommand: 'sleep 3600',
        installScript: '#!/bin/sh\ntrue',
      },
    });
    templateId = template.id;

    const server = await asAdmin((tx) =>
      tx.server.create({
        data: {
          shortId: `rls${String(suffix).slice(-5)}`,
          ownerId,
          nodeId: node.id,
          templateId: template.id,
          name: 'RLS Test Server',
          dockerImage: 'alpine',
          startupCommand: 'sleep 3600',
          memoryMb: 512,
          diskMb: 1024,
        },
      }),
    );
    serverId = server.id;
  });

  afterAll(async () => {
    // FK-ordered teardown: server first (its backups/subusers cascade with
    // it), then the node/template fixtures that reference the group/
    // location, then the group and location themselves. An earlier
    // version of this cleanup only deleted the server and the two users,
    // silently leaking a location + node + template group + template on
    // every single test run — harmless to correctness, but after enough
    // CI/local runs it's a real "why are there 40 fake locations in my
    // dev database" surprise. Caught by hand, not by a failing assertion,
    // while using this same database for the M4 live agent<->panel test.
    await asAdmin((tx) => tx.server.deleteMany({ where: { id: serverId } }));
    if (nodeId) await prisma.node.deleteMany({ where: { id: nodeId } });
    if (templateId) await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    if (groupId) await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, intruderId] } } });
    await app.close();
  });

  it('a bare write with NO RLS context is rejected by the WITH CHECK policy', async () => {
    // This is the negative-of-the-negative: without withRLS, app_user has
    // no app.user_id/app.is_admin set at all, so even inserting a server
    // for a real, valid owner is refused outright by Postgres itself.
    await expect(
      prisma.server.create({
        data: {
          shortId: 'norls001',
          ownerId,
          nodeId: (await prisma.node.findFirstOrThrow()).id,
          templateId: (await prisma.serverTemplate.findFirstOrThrow()).id,
          name: 'Should Never Be Created',
          dockerImage: 'alpine',
          startupCommand: 'sleep 3600',
          memoryMb: 512,
          diskMb: 1024,
        },
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the owner can see their own server via RLS', async () => {
    const rows = await prisma.withRLS({ userId: ownerId, isAdmin: false }, (tx) =>
      tx.server.findMany({ where: { id: serverId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it("a non-owner's raw RLS-scoped query returns ZERO rows for someone else's server", async () => {
    const rows = await prisma.withRLS({ userId: intruderId, isAdmin: false }, (tx) =>
      tx.server.findMany({ where: { id: serverId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('an admin context can see the server regardless of ownership', async () => {
    const rows = await prisma.withRLS({ userId: intruderId, isAdmin: true }, (tx) =>
      tx.server.findMany({ where: { id: serverId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('ServerAccessService.resolve returns the server for the owner', async () => {
    const ctx = await access.resolve(ownerId, serverId);
    expect(ctx.role).toBe('owner');
    expect(ctx.server.id).toBe(serverId);
  });

  it('ServerAccessService.resolve 404s for a non-owner — never confirms existence', async () => {
    await expect(access.resolve(intruderId, serverId)).rejects.toMatchObject({ status: 404 });
  });

  it('a subuser with an ACCEPTED invite can see the server; a pending one cannot', async () => {
    const suffix = Date.now();
    const invitee = await prisma.user.create({
      data: { email: `rls-subuser-${suffix}@pxhost.local`, username: `rls-subuser-${suffix}`, passwordHash: 'x', isActive: true },
    });

    await asAdmin((tx) =>
      tx.subuser.create({ data: { serverId, userId: invitee.id, permissions: ['control.console'], acceptedAt: null } }),
    );
    const pendingRows = await prisma.withRLS({ userId: invitee.id, isAdmin: false }, (tx) =>
      tx.server.findMany({ where: { id: serverId } }),
    );
    expect(pendingRows).toHaveLength(0);

    await asAdmin((tx) => tx.subuser.updateMany({ where: { serverId, userId: invitee.id }, data: { acceptedAt: new Date() } }));
    const acceptedRows = await prisma.withRLS({ userId: invitee.id, isAdmin: false }, (tx) =>
      tx.server.findMany({ where: { id: serverId } }),
    );
    expect(acceptedRows).toHaveLength(1);

    await asAdmin((tx) => tx.subuser.deleteMany({ where: { serverId, userId: invitee.id } }));
    await prisma.user.delete({ where: { id: invitee.id } });
  });

  it('backups inherit the same RLS scoping via can_access_server', async () => {
    const backup = await asAdmin((tx) => tx.backup.create({ data: { serverId, name: 'rls-test-backup' } }));

    const ownerRows = await prisma.withRLS({ userId: ownerId, isAdmin: false }, (tx) =>
      tx.backup.findMany({ where: { id: backup.id } }),
    );
    expect(ownerRows).toHaveLength(1);

    const intruderRows = await prisma.withRLS({ userId: intruderId, isAdmin: false }, (tx) =>
      tx.backup.findMany({ where: { id: backup.id } }),
    );
    expect(intruderRows).toHaveLength(0);

    await asAdmin((tx) => tx.backup.delete({ where: { id: backup.id } }));
  });

  it('audit_logs is append-only: UPDATE and DELETE are rejected at the database level', async () => {
    const log = await prisma.auditLog.create({ data: { action: 'rls.e2e.test' } });

    await expect(prisma.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
  });
});
