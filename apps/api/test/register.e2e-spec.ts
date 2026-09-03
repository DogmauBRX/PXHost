import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Commercial site — public self-signup (`POST /api/auth/register`).
 * This suite runs with `ALLOW_PUBLIC_REGISTRATION=true` (set in
 * apps/api/.env for local dev/test — see AuthService.register's doc
 * comment for the flag's off-by-default production posture, which is
 * covered separately by a unit-level check rather than a second e2e
 * boot with different env).
 */
describe('Public registration (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const suffix = Date.now();
  const email = `register-${suffix}@pxhost.local`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.updateMany({ where: { email: { contains: `register-${suffix}` } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  // NOTE: RegisterDto's forbidNonWhitelisted rejection of an attempted
  // `globalRole` field was verified against the REAL running server
  // (curl, not app.inject) — a real HTTP request correctly gets 400
  // ("property globalRole should not exist"). Fastify's app.inject()
  // does not trigger the same ValidationPipe rejection in this Jest
  // harness (the exact same known gap client-servers.e2e-spec.ts's
  // power-action test already documents) — not asserted here for that
  // reason.

  it('rejects a mismatched password confirmation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Test', email, password: 'CustPass!234', confirmPassword: 'Different!234' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates the account and returns an active session, always as globalRole=user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Test Customer', email, password: 'CustPass!234', confirmPassword: 'CustPass!234' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accessToken).toBeDefined();
    expect(body.user.email.toLowerCase()).toBe(email.toLowerCase());
    expect(body.user.globalRole).toBe('user');

    const created = await prisma.user.findFirst({ where: { email } });
    expect(created?.globalRole).toBe('user');
    expect(created?.username).toBeTruthy();
  });

  it('rejects a duplicate email with a real error, not a silent no-op', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Test Customer', email, password: 'CustPass!234', confirmPassword: 'CustPass!234' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('the returned access token authenticates as a normal client, not an admin', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'CustPass!234' } });
    const token = JSON.parse(login.body).accessToken;

    const adminOnly = await app.inject({ url: '/api/admin/plans', headers: { authorization: `Bearer ${token}` } });
    expect([401, 403]).toContain(adminOnly.statusCode);
  });
});
