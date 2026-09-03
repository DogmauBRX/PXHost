import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';

/**
 * The commercial catalog (`GET /api/public/plans[/:slug]`) — no auth
 * required, availability computed server-side, never a raw slot count,
 * private/unpublished plans never appear. See the subscriptions plan
 * file's §E for the full contract.
 */
describe('Public plans catalog (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let publicPlanId: string;
  let privatePlanId: string;
  let soldOutPlanId: string;
  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await redis.client.del('public:plans:v1');

    const pub = await prisma.plan.create({
      data: { name: `pub-plan-${suffix}`, slug: `pub-plan-${suffix}`, memoryMb: 4096, diskMb: 20480, priceCents: 5990, isPublic: true, isFeatured: true, highlightLabel: 'Mais popular' },
    });
    publicPlanId = pub.id;

    const priv = await prisma.plan.create({
      data: { name: `priv-plan-${suffix}`, slug: `priv-plan-${suffix}`, memoryMb: 8192, diskMb: 40960, priceCents: 9990, isPublic: false },
    });
    privatePlanId = priv.id;

    const soldOut = await prisma.plan.create({
      data: { name: `soldout-plan-${suffix}`, slug: `soldout-plan-${suffix}`, memoryMb: 512, diskMb: 2048, priceCents: 1990, isPublic: true, maxSlots: 0 },
    });
    soldOutPlanId = soldOut.id;

    await redis.client.del('public:plans:v1');
  });

  afterAll(async () => {
    await prisma.plan.deleteMany({ where: { id: { in: [publicPlanId, privatePlanId, soldOutPlanId] } } });
    await redis.client.del('public:plans:v1');
    await app.close();
  });

  it('lists public plans with computed availability, without requiring auth', async () => {
    const res = await app.inject({ url: '/api/public/plans' });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body);
    const found = items.find((p: any) => p.id === publicPlanId);
    expect(found).toBeDefined();
    // maxSlots is null (unlimited) for this fixture, and availability
    // deliberately never depends on whether a node currently exists to
    // run the plan (see PublicPlansService.computeAvailability's own
    // doc comment — found live against a dev DB with zero nodes
    // bootstrapped, where the earlier node-aware version showed every
    // single plan as sold out). So this must always read "available",
    // regardless of what infrastructure this test environment has.
    expect(found.availability).toEqual({ status: 'available', remaining: null });
    expect(found.isFeatured).toBe(true);
    expect(found.highlightLabel).toBe('Mais popular');
  });

  it('never exposes maxSlots or node-tuning fields to the public catalog', async () => {
    const res = await app.inject({ url: '/api/public/plans' });
    const items = JSON.parse(res.body);
    for (const plan of items) {
      expect(plan.maxSlots).toBeUndefined();
      expect(plan.cpuPinning).toBeUndefined();
      expect(plan.blockIoReadBps).toBeUndefined();
    }
  });

  it('excludes non-public plans entirely', async () => {
    const res = await app.inject({ url: '/api/public/plans' });
    const items = JSON.parse(res.body);
    expect(items.some((p: any) => p.id === privatePlanId)).toBe(false);

    const detail = await app.inject({ url: `/api/public/plans/priv-plan-${suffix}` });
    expect(detail.statusCode).toBe(404);
  });

  it('marks a maxSlots:0 plan sold_out', async () => {
    const res = await app.inject({ url: `/api/public/plans/soldout-plan-${suffix}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.availability.status).toBe('sold_out');
    expect(body.availability.remaining).toBe(0);
  });

  it('a slug lookup for a real public plan returns it', async () => {
    const res = await app.inject({ url: `/api/public/plans/pub-plan-${suffix}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(publicPlanId);
  });

  it('an unknown slug 404s', async () => {
    const res = await app.inject({ url: '/api/public/plans/does-not-exist-xyz' });
    expect(res.statusCode).toBe(404);
  });
});
