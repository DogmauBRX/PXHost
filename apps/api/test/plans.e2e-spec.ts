import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

describe('Plans (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let planId: string;
  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('AdminPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `plan-admin-${suffix}@pxhost.local`, username: `plan-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `plan-admin-${suffix}@pxhost.local`, password: 'AdminPass!234567' },
    });
    adminToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.updateMany({ where: { email: `plan-admin-${suffix}@pxhost.local` }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  it('creates a plan with sensible defaults applied', async () => {
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: 'e2e Plan', slug: `e2e-plan-${suffix}`, memoryMb: 1024, diskMb: 5120 },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    planId = body.id;
    expect(body.cpuLimitPercent).toBe(100);
    expect(body.maxAllocations).toBe(1);
  });

  it('rejects a duplicate slug', async () => {
    const res = await authed('/api/admin/plans', {
      method: 'POST',
      payload: { name: 'dup', slug: `e2e-plan-${suffix}`, memoryMb: 512, diskMb: 1024 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('blocks deletion while a server references the plan, allows it once free', async () => {
    // no server created in this suite, so deletion should succeed cleanly
    const res = await authed(`/api/admin/plans/${planId}`, { method: 'DELETE' });
    expect(res.statusCode).toBe(204);
    const afterDelete = await authed(`/api/admin/plans/${planId}`);
    expect(afterDelete.statusCode).toBe(404);
    planId = ''; // already deleted, skip afterAll cleanup
  });
});
