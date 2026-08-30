import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import * as argon2 from 'argon2';

/**
 * End-to-end auth flow against a REAL Postgres + Redis (docker-compose.dev.yml).
 * Covers milestone M3's stated DoD: "login/refresh/logout works" plus the
 * two security properties architecture doc 3.2 calls out explicitly —
 * refresh rotation and reuse detection.
 *
 * Requires: `docker compose -f docker-compose.dev.yml up -d`, migrations
 * applied (`pnpm prisma:migrate:deploy`), then `pnpm test:e2e`.
 */
describe('Auth (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = `e2e-auth-${Date.now()}@pxhost.local`;
  const password = 'CorrectHorseBatteryStaple!23';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
      hashLength: 32,
    });
    await prisma.user.create({
      data: { email, username: `e2e-auth-${Date.now()}`, passwordHash, isActive: true, emailVerifiedAt: new Date() },
    });
  });

  afterAll(async () => {
    // Soft-delete, not a hard delete: this test's login attempts write
    // audit_logs rows referencing this user (actorId, ON DELETE SET
    // NULL). audit_logs is append-only at the database level (a trigger
    // rejects UPDATE outright — see migration 0002_rls_policies), and the
    // FK's own SET NULL action IS an UPDATE, so a hard delete of a user
    // with audit history is correctly refused by the same immutability
    // guarantee that protects the trail from tampering. Soft-delete
    // (`deleted_at`) is the pattern architecture doc 2.2 specifies for
    // `users` precisely so this conflict never needs to arise in real
    // application code — worth knowing if a real account-deletion feature
    // is ever built: hard-deleting a user with audit history needs a
    // deliberate decision (e.g. a narrower trigger that allows only the
    // FK's own SET NULL), not just `DELETE FROM users`.
    if (prisma) {
      await prisma.user.updateMany({ where: { email }, data: { deletedAt: new Date() } });
    }
    if (app) {
      await app.close();
    }
  });

  function cookieHeader(setCookieHeaders: string[] | string | undefined): string {
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    return arr.map((c) => c.split(';')[0]).join('; ');
  }

  it('rejects login with the wrong password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects login for a nonexistent email with the SAME error shape (no enumeration)', async () => {
    const wrongPw = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'wrong' } });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'definitely-not-registered@pxhost.local', password: 'wrong' },
    });
    expect(noSuchUser.statusCode).toBe(wrongPw.statusCode);
    expect(JSON.parse(noSuchUser.body).message).toBe(JSON.parse(wrongPw.body).message);
  });

  it('logs in successfully and sets a refresh cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.email).toBe(email.toLowerCase());
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('the access token authenticates /api/auth/me', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const { accessToken } = JSON.parse(login.body);

    const me = await app.inject({ method: 'POST', url: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).email).toBe(email.toLowerCase());
  });

  it('rejects requests with no token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('refresh rotates the token and issues a new access token', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const cookie = cookieHeader(login.headers['set-cookie'] as any);

    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
    expect(refreshed.statusCode).toBe(200);
    const newCookie = cookieHeader(refreshed.headers['set-cookie'] as any);
    expect(newCookie).not.toBe(cookie); // the refresh token itself rotated
  });

  it('reusing an already-rotated refresh token is rejected and revokes the whole family', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const originalCookie = cookieHeader(login.headers['set-cookie'] as any);

    // First refresh: legitimate, rotates the token.
    const first = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: originalCookie } });
    expect(first.statusCode).toBe(200);
    const rotatedCookie = cookieHeader(first.headers['set-cookie'] as any);

    // Reuse of the ORIGINAL (already-rotated-out) token: this is the
    // reuse-detection scenario — proof of theft, per architecture doc 3.2.
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: originalCookie } });
    expect(reuse.statusCode).toBe(401);

    // The reuse must have revoked the ENTIRE family: even the token that
    // was legitimately rotated to (rotatedCookie) must now be dead too.
    const afterReuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: rotatedCookie } });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('logout revokes the session — the access token stops working immediately', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const { accessToken } = JSON.parse(login.body);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logout.statusCode).toBe(204);

    const meAfter = await app.inject({
      method: 'POST',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });
});
