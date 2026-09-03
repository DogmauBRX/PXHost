import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { createHash } from 'node:crypto';
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
  let redis: RedisService;
  const email = `e2e-auth-${Date.now()}@pxhost.local`;
  const password = 'CorrectHorseBatteryStaple!23';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
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

  // Client account management, Fase 1 — forgot/reset password. The raw
  // token is never returned by the API (that would defeat the whole
  // point), so the redemption tests seed a KNOWN token directly into
  // Redis using the exact same hash scheme AuthService's private
  // passwordResetRedisKey uses, then exercise the real HTTP endpoint —
  // the generation half is still tested through the real endpoint (test
  // below asserts a new Redis key with the right TTL appears).
  describe('forgot/reset password', () => {
    let resetEmail: string;
    let resetUserId: string;
    const resetPassword_ = 'OriginalPass!234567';

    function pwResetKey(token: string): string {
      return `pwreset:${createHash('sha256').update(token).digest('hex')}`;
    }

    beforeAll(async () => {
      // Rate-limit counters have a 1-hour TTL and are keyed by IP, which
      // app.inject() reports as a fixed loopback address — so they
      // persist ACROSS test runs within the same hour against a shared
      // dev Redis, not just within one run. Flushing them here keeps this
      // describe block's exact-count assertions deterministic regardless
      // of how many times the suite has already run recently.
      const staleRateLimitKeys = await redis.client.keys('pwreset_rl:*');
      if (staleRateLimitKeys.length > 0) await redis.client.del(...staleRateLimitKeys);

      const passwordHash = await argon2.hash(resetPassword_, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
      resetEmail = `e2e-pwreset-${Date.now()}@pxhost.local`;
      const user = await prisma.user.create({
        data: { email: resetEmail, username: `e2e-pwreset-${Date.now()}`, passwordHash, isActive: true, emailVerifiedAt: new Date() },
      });
      resetUserId = user.id;
    });

    afterAll(async () => {
      await prisma.user.updateMany({ where: { id: resetUserId }, data: { deletedAt: new Date() } });
    });

    it('an existing email gets the generic message and a single-use Redis token with the right TTL', async () => {
      const before = await redis.client.keys('pwreset:*');
      const res = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: resetEmail } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toEqual(expect.any(String));

      const after = await redis.client.keys('pwreset:*');
      expect(after.length).toBe(before.length + 1);
      const newKey = after.find((k) => !before.includes(k))!;
      const ttl = await redis.client.ttl(newKey);
      expect(ttl).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);

      const auditRow = await prisma.auditLog.findFirst({ where: { action: 'auth.password_reset.requested', actorId: resetUserId } });
      expect(auditRow).not.toBeNull();
    });

    it('a nonexistent email gets the IDENTICAL response and creates no token', async () => {
      const nonexistentEmail = `e2e-pwreset-nosuchuser-${Date.now()}@pxhost.local`;
      const known = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: resetEmail } });
      const before = await redis.client.keys('pwreset:*');
      const unknown = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: nonexistentEmail } });
      const after = await redis.client.keys('pwreset:*');

      expect(unknown.statusCode).toBe(known.statusCode);
      expect(JSON.parse(unknown.body).message).toBe(JSON.parse(known.body).message);
      expect(after.length).toBe(before.length); // no token minted for an unknown email
    });

    it('exceeding the per-email rate limit returns 429', async () => {
      const rateLimitedEmail = `e2e-pwreset-ratelimit-${Date.now()}@pxhost.local`;
      let last: { statusCode: number } = { statusCode: 0 };
      for (let i = 0; i < 6; i++) {
        last = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: rateLimitedEmail } });
      }
      expect(last.statusCode).toBe(429);
    });

    it('rejects newPassword/confirmPassword mismatch before touching the token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: 'irrelevant-garbage-token', newPassword: 'NewPassword!234567', confirmPassword: 'Different!234567' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a newPassword shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: 'irrelevant-garbage-token', newPassword: 'short', confirmPassword: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid/unknown token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: 'this-token-was-never-issued', newPassword: 'NewPassword!234567', confirmPassword: 'NewPassword!234567' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('a valid token completes the reset, logs the old password out everywhere, and burns on use', async () => {
      // A JWT minted BEFORE the reset, to prove it's rejected after. JWT
      // `iat` is whole-second resolution and JwtAuthGuard deliberately
      // floors tokensValidAfter to match (see its own doc comment) — a
      // token minted in the SAME wall-clock second as the revocation is
      // treated as still valid by design, so this needs to cross a real
      // second boundary to actually exercise the check.
      const preResetLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: resetEmail, password: resetPassword_ } });
      const preResetToken = JSON.parse(preResetLogin.body).accessToken;
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const rawToken = `prt_e2e_${Date.now()}`;
      await redis.client.set(pwResetKey(rawToken), resetUserId, 'EX', 3600);

      const newPassword = 'BrandNewPass!234567';
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: rawToken, newPassword, confirmPassword: newPassword },
      });
      expect(res.statusCode).toBe(200);

      const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: resetEmail, password: newPassword } });
      expect(newLogin.statusCode).toBe(200);

      const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: resetEmail, password: resetPassword_ } });
      expect(oldLogin.statusCode).toBe(401);

      const staleTokenCheck = await app.inject({ method: 'POST', url: '/api/auth/me', headers: { authorization: `Bearer ${preResetToken}` } });
      expect(staleTokenCheck.statusCode).toBe(401);

      // Burn-on-use: the same raw token cannot be redeemed a second time.
      const reuse = await app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: rawToken, newPassword: 'AnotherPass!234567', confirmPassword: 'AnotherPass!234567' },
      });
      expect(reuse.statusCode).toBe(400);

      const auditRow = await prisma.auditLog.findFirst({ where: { action: 'auth.password_reset.completed', actorId: resetUserId } });
      expect(auditRow).not.toBeNull();
    });
  });
});
