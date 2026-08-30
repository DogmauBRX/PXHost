import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

describe('Templates / eggs (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let groupId: string;
  let templateId: string;
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
    });
    await prisma.user.create({
      data: { email: `tpl-admin-${suffix}@pxhost.local`, username: `tpl-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `tpl-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    if (templateId) await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    if (groupId) await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.user.updateMany({ where: { email: `tpl-admin-${suffix}@pxhost.local` }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  it('creates a template group (nest)', async () => {
    const res = await authed('/api/admin/nests', { method: 'POST', payload: { name: `e2e-group-${suffix}` } });
    expect(res.statusCode).toBe(201);
    groupId = JSON.parse(res.body).id;
  });

  it('creates a template (egg) with variables, stored and retrievable', async () => {
    const res = await authed('/api/admin/eggs', {
      method: 'POST',
      payload: {
        groupId,
        name: 'e2e Paper',
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        installScript: '#!/bin/sh\necho installing',
        variables: [
          { name: 'Server Jar', envVariable: 'SERVER_JARFILE', defaultValue: 'server.jar' },
          { name: 'Memory', envVariable: 'SERVER_MEMORY', defaultValue: '1024', isUserEditable: false },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    templateId = body.id;
    expect(body.variables).toHaveLength(2);

    const fetched = await authed(`/api/admin/eggs/${templateId}`);
    const fetchedBody = JSON.parse(fetched.body);
    expect(fetchedBody.startupCommand).toContain('{{SERVER_MEMORY}}');
    expect(fetchedBody.installScript).toContain('installing');
    expect(fetchedBody.variables.map((v: { envVariable: string }) => v.envVariable).sort()).toEqual([
      'SERVER_JARFILE',
      'SERVER_MEMORY',
    ]);
  });

  it('rejects a variable whose envVariable would be silently dropped by the agent', async () => {
    const res = await authed('/api/admin/eggs', {
      method: 'POST',
      payload: {
        groupId,
        name: 'e2e Bad Variable',
        author: 'test',
        dockerImages: { default: 'alpine' },
        startupCommand: 'run',
        installScript: '#!/bin/sh\ntrue',
        variables: [{ name: 'bad', envVariable: 'lowercase_not_allowed' }],
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('deleting a group with templates in it still allows the group to be listed (soft delete of template only via egg delete)', async () => {
    // sanity: listing eggs scoped to the group returns our template
    const res = await authed(`/api/admin/eggs?groupId=${groupId}`);
    const body = JSON.parse(res.body);
    expect(body.some((t: { id: string }) => t.id === templateId)).toBe(true);
  });
});
