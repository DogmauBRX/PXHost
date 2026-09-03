import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Client account management, Fase 1 — self-service profile view/edit and
 * password change on `/api/client/account/*`. Mirrors the test-user/login
 * bootstrap pattern already established in client-servers.e2e-spec.ts.
 */
describe('Account (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let userId: string;
  let userEmail: string;
  const suffix = Date.now();
  const password = 'AccountPass!234567';

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${accessToken}` }, ...opts });
  }

  let accessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    userEmail = `account-e2e-${suffix}@pxhost.local`;
    const user = await prisma.user.create({
      data: { email: userEmail, username: `account-e2e-${suffix}`, passwordHash, isActive: true, emailVerifiedAt: new Date() },
    });
    userId = user.id;

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: userEmail, password } });
    accessToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    if (prisma) await prisma.user.updateMany({ where: { id: userId }, data: { deletedAt: new Date() } });
    if (app) await app.close();
  });

  it('rejects every account route without a token', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/client/account' });
    expect(get.statusCode).toBe(401);
    const patch = await app.inject({ method: 'PATCH', url: '/api/client/account', payload: {} });
    expect(patch.statusCode).toBe(401);
    const changePw = await app.inject({ method: 'POST', url: '/api/client/account/change-password', payload: {} });
    expect(changePw.statusCode).toBe(401);
  });

  it('returns the own profile, never the password hash', async () => {
    const res = await authed('/api/client/account');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(userId);
    expect(body.email).toBe(userEmail);
    expect(body.passwordHash).toBeUndefined();
  });

  it('updates name/username without requiring currentPassword', async () => {
    const res = await authed('/api/client/account', {
      method: 'PATCH',
      payload: { firstName: 'Test', lastName: 'User', username: `account-e2e-renamed-${suffix}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.firstName).toBe('Test');
    expect(body.lastName).toBe('User');
    expect(body.username).toBe(`account-e2e-renamed-${suffix}`);
  });

  it('rejects an email change without currentPassword', async () => {
    const res = await authed('/api/client/account', {
      method: 'PATCH',
      payload: { email: `account-e2e-new-${suffix}@pxhost.local` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an email change with the wrong currentPassword', async () => {
    const res = await authed('/api/client/account', {
      method: 'PATCH',
      payload: { email: `account-e2e-new-${suffix}@pxhost.local`, currentPassword: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts an email change with the correct currentPassword and clears emailVerifiedAt', async () => {
    const newEmail = `account-e2e-new-${suffix}@pxhost.local`;
    const res = await authed('/api/client/account', {
      method: 'PATCH',
      payload: { email: newEmail, currentPassword: password },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.email).toBe(newEmail);
    expect(body.emailVerifiedAt).toBeNull();
    userEmail = newEmail;
  });

  it('rejects changing email to one already taken', async () => {
    const other = await prisma.user.create({
      data: {
        email: `account-e2e-taken-${suffix}@pxhost.local`,
        username: `account-e2e-taken-${suffix}`,
        passwordHash: await argon2.hash('Whatever!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 }),
        isActive: true,
      },
    });
    const res = await authed('/api/client/account', {
      method: 'PATCH',
      payload: { email: other.email, currentPassword: password },
    });
    expect(res.statusCode).toBe(409);
    await prisma.user.updateMany({ where: { id: other.id }, data: { deletedAt: new Date() } });
  });

  it('change-password with the wrong currentPassword fails and changes nothing', async () => {
    const res = await authed('/api/client/account/change-password', {
      method: 'POST',
      payload: { currentPassword: 'wrong', newPassword: 'NewPassword!234567', confirmPassword: 'NewPassword!234567' },
    });
    expect(res.statusCode).toBe(401);

    const stillOldPassword = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: userEmail, password } });
    expect(stillOldPassword.statusCode).toBe(200);
  });

  it('change-password with mismatched newPassword/confirmPassword fails', async () => {
    const res = await authed('/api/client/account/change-password', {
      method: 'POST',
      payload: { currentPassword: password, newPassword: 'NewPassword!234567', confirmPassword: 'Different!234567' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('change-password with the correct currentPassword succeeds, logs in with the new password, and the caller\'s own token stops working', async () => {
    // JWT `iat` is whole-second resolution and JwtAuthGuard deliberately
    // floors tokensValidAfter to match (see the guard's own doc comment)
    // — a token minted in the SAME wall-clock second as the revocation
    // is treated as still valid by design, so this needs to cross a real
    // second boundary before the stale-token assertion below is meaningful.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const newPassword = 'NewPassword!234567';
    const res = await authed('/api/client/account/change-password', {
      method: 'POST',
      payload: { currentPassword: password, newPassword, confirmPassword: newPassword },
    });
    expect(res.statusCode).toBe(200);

    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: userEmail, password: newPassword } });
    expect(newLogin.statusCode).toBe(200);

    const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: userEmail, password } });
    expect(oldLogin.statusCode).toBe(401);

    // The token that authorized the change-password call itself is now
    // stale — tokensValidAfter was bumped past its iat.
    const staleTokenCheck = await authed('/api/client/account');
    expect(staleTokenCheck.statusCode).toBe(401);
  });
});
