import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

describe('Admin users (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let rootToken: string;
  let adminAToken: string;
  let adminBToken: string;
  let adminBId: string;
  let supportToken: string;
  const suffix = Date.now();
  const emails = {
    root: `users-e2e-root-${suffix}@pxhost.local`,
    adminA: `users-e2e-admin-a-${suffix}@pxhost.local`,
    adminB: `users-e2e-admin-b-${suffix}@pxhost.local`,
    support: `users-e2e-support-${suffix}@pxhost.local`,
  };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('FixturePass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });

    async function seedAndLogin(email: string, globalRole: string): Promise<{ id: string; token: string }> {
      const user = await prisma.user.create({
        data: { email, username: email.split('@')[0], passwordHash, globalRole, isActive: true },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'FixturePass!234567' },
      });
      return { id: user.id, token: JSON.parse(login.body).accessToken };
    }

    const root = await seedAndLogin(emails.root, 'root_admin');
    rootToken = root.token;
    const adminA = await seedAndLogin(emails.adminA, 'admin');
    adminAToken = adminA.token;
    const adminB = await seedAndLogin(emails.adminB, 'admin');
    adminBToken = adminB.token;
    adminBId = adminB.id;
    const support = await seedAndLogin(emails.support, 'support');
    supportToken = support.token;
  });

  afterAll(async () => {
    if (createdUserIds.length) await prisma.user.updateMany({ where: { id: { in: createdUserIds } }, data: { deletedAt: new Date() } });
    await prisma.user.updateMany({ where: { email: { in: Object.values(emails) } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(token: string, url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${token}` }, ...opts });
  }

  it('root_admin can create a client', async () => {
    const res = await authed(rootToken, '/api/admin/users', {
      method: 'POST',
      payload: { email: `users-e2e-client-${suffix}@pxhost.local`, username: `users-e2e-client-${suffix}`, password: 'ClientPass!234567' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.globalRole).toBe('user');
    expect(body.passwordHash).toBeUndefined();
    createdUserIds.push(body.id);
  });

  it('support cannot create a user (missing clients.create)', async () => {
    const res = await authed(supportToken, '/api/admin/users', {
      method: 'POST',
      payload: { email: `users-e2e-support-create-${suffix}@pxhost.local`, username: `users-e2e-support-create-${suffix}`, password: 'ClientPass!234567' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('support CAN list users (clients.view default)', async () => {
    const res = await authed(supportToken, '/api/admin/users');
    expect(res.statusCode).toBe(200);
  });

  it('admin cannot create a root_admin (role assignment above own rank)', async () => {
    const res = await authed(adminAToken, '/api/admin/users', {
      method: 'POST',
      payload: {
        email: `users-e2e-escalate-${suffix}@pxhost.local`,
        username: `users-e2e-escalate-${suffix}`,
        password: 'ClientPass!234567',
        globalRole: 'root_admin',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin cannot promote an existing user to root_admin via PATCH', async () => {
    const create = await authed(rootToken, '/api/admin/users', {
      method: 'POST',
      payload: { email: `users-e2e-promote-${suffix}@pxhost.local`, username: `users-e2e-promote-${suffix}`, password: 'ClientPass!234567' },
    });
    const target = JSON.parse(create.body);
    createdUserIds.push(target.id);

    const res = await authed(adminAToken, `/api/admin/users/${target.id}`, {
      method: 'PATCH',
      payload: { globalRole: 'root_admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin cannot act on a PEER admin (equal rank)', async () => {
    const res = await authed(adminAToken, `/api/admin/users/${adminBId}/block`, { method: 'POST' });
    expect(res.statusCode).toBe(403);
  });

  it('admin cannot change their own role', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emails.adminA, password: 'FixturePass!234567' } });
    const meId = JSON.parse(login.body).user.id;
    const res = await authed(adminAToken, `/api/admin/users/${meId}`, { method: 'PATCH', payload: { globalRole: 'support' } });
    expect(res.statusCode).toBe(409);
  });

  it('a user cannot block their own account', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emails.adminA, password: 'FixturePass!234567' } });
    const meId = JSON.parse(login.body).user.id;
    const res = await authed(adminAToken, `/api/admin/users/${meId}/block`, { method: 'POST' });
    expect(res.statusCode).toBe(409);
  });

  it('root_admin CAN block a peer/superior admin', async () => {
    const res = await authed(rootToken, `/api/admin/users/${adminBId}/block`, { method: 'POST' });
    expect(res.statusCode).toBe(204);
    await authed(rootToken, `/api/admin/users/${adminBId}/unblock`, { method: 'POST' });
  });

  it('a malformed id is rejected as 400, not a raw 500 from Postgres', async () => {
    const res = await authed(rootToken, '/api/admin/users/not-a-uuid', { method: 'PATCH', payload: { firstName: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('a non-admin (client) token is refused entirely', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `users-e2e-client-${suffix}@pxhost.local`, password: 'ClientPass!234567' },
    });
    const clientToken = JSON.parse(login.body).accessToken;
    const res = await authed(clientToken, '/api/admin/users');
    expect(res.statusCode).toBe(403);
  });
});
