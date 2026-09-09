import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
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
  let adminToken: string;
  let locationId: string;
  let keeperNodeId: string;
  let publicPlanId: string;
  let privatePlanId: string;
  let soldOutPlanId: string;
  const suffix = Date.now();

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }
  function asAdmin<T>(fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await redis.client.del('public:plans:v1');

    // Admin only for fixture setup below (nodes/plan-node restrictions)
    // — every assertion in this file still hits the UNAUTHENTICATED
    // public surface.
    const passwordHash = await argon2.hash('AdminPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({ data: { email: `pubplans-admin-${suffix}@gxhost.local`, username: `pubplans-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `pubplans-admin-${suffix}@gxhost.local`, password: 'AdminPass!234567' } });
    adminToken = JSON.parse(login.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `pubplans-e2e-${suffix}`, name: 'Public Plans E2E Location' } });
    locationId = loc.id;

    // Keeps `hasAnyHealthyNode` true for the whole suite, regardless of
    // what any OTHER concurrently-running e2e file's nodes are doing —
    // deliberately unrestricted to any specific plan below.
    const keeper = await prisma.node.create({
      data: { locationId, name: `pubplans-keeper-${suffix}`, fqdn: `pubplans-keeper-${suffix}.test`, memoryTotalMb: 999_999, diskTotalMb: 999_999, lastHeartbeatAt: new Date() },
    });
    keeperNodeId = keeper.id;

    const pub = await prisma.plan.create({
      data: { name: `pub-plan-${suffix}`, slug: `pub-plan-${suffix}`, memoryMb: 4096, diskMb: 20480, priceCents: 5990, isPublic: true, isFeatured: true, highlightLabel: 'Mais popular' },
    });
    publicPlanId = pub.id;
    // Restricted to the (deliberately generous) keeper node alone, so
    // this fixture's derived capacity is deterministic — immune to
    // whatever other nodes exist in the shared test database.
    await authed(`/api/admin/plans/${publicPlanId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId: keeperNodeId }] } });

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
    await asAdmin((tx) => tx.planNode.deleteMany({ where: { planId: publicPlanId } }));
    await prisma.plan.deleteMany({ where: { id: { in: [publicPlanId, privatePlanId, soldOutPlanId] } } });
    await prisma.node.deleteMany({ where: { locationId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: `pubplans-admin-${suffix}@gxhost.local` }, data: { deletedAt: new Date() } });
    await redis.client.del('public:plans:v1');
    await app.close();
  });

  it('lists public plans with computed availability, without requiring auth', async () => {
    const res = await app.inject({ url: '/api/public/plans' });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body);
    const found = items.find((p: any) => p.id === publicPlanId);
    expect(found).toBeDefined();
    // maxSlots is null (unlimited) for this fixture, and it's restricted
    // to a single, generously-sized "keeper" node — plenty of real
    // capacity, so this must read "available" regardless of whatever
    // else is going on in the shared test database (see
    // PublicPlansService.computeAvailability's own doc comment for the
    // historical incident — a dev DB with zero nodes showing every
    // single plan as sold out — this suite's `keeperNodeId` fixture and
    // `hasAnyHealthyNode` gate exist specifically to prevent).
    expect(found.availability.status).toBe('available');
    expect(found.isFeatured).toBe(true);
    expect(found.highlightLabel).toBe('Mais popular');
  });

  it('a commercially-unlimited plan (maxSlots: null) is correctly sold_out when its only eligible node is too small for it', async () => {
    const tiny = await prisma.node.create({
      data: { locationId, name: `pubplans-tiny-${suffix}`, fqdn: `pubplans-tiny-${suffix}.test`, memoryTotalMb: 100, diskTotalMb: 100, lastHeartbeatAt: new Date() },
    });
    const plan = await prisma.plan.create({
      data: { name: `pubplans-tootight-${suffix}`, slug: `pubplans-tootight-${suffix}`, memoryMb: 4096, diskMb: 512, priceCents: 1000, isPublic: true },
    });
    await authed(`/api/admin/plans/${plan.id}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId: tiny.id }] } });
    await redis.client.del('public:plans:v1');

    const res = await app.inject({ url: `/api/public/plans/pubplans-tootight-${suffix}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.availability.status).toBe('sold_out');
    expect(body.availability.remaining).toBe(0);

    await asAdmin((tx) => tx.planNode.deleteMany({ where: { planId: plan.id } }));
    await prisma.plan.deleteMany({ where: { id: plan.id } });
    await prisma.node.deleteMany({ where: { id: tiny.id } });
    await redis.client.del('public:plans:v1');
  });

  it('effective slots are the tighter of maxSlots and real node capacity', async () => {
    const roomy = await prisma.node.create({
      data: { locationId, name: `pubplans-roomy-${suffix}`, fqdn: `pubplans-roomy-${suffix}.test`, memoryTotalMb: 100_000, diskTotalMb: 100_000, lastHeartbeatAt: new Date() },
    });
    // 100000 / 4000 = 25 servers of real capacity, but maxSlots caps it
    // commercially at 2 — the commercial ceiling must win here.
    const plan = await prisma.plan.create({
      data: { name: `pubplans-capped-${suffix}`, slug: `pubplans-capped-${suffix}`, memoryMb: 4000, diskMb: 512, priceCents: 1000, isPublic: true, maxSlots: 2 },
    });
    await authed(`/api/admin/plans/${plan.id}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId: roomy.id }] } });
    await redis.client.del('public:plans:v1');

    const res = await app.inject({ url: `/api/public/plans/pubplans-capped-${suffix}` });
    const body = JSON.parse(res.body);
    expect(body.availability.status).toBe('limited'); // 2 remaining, at/under the low-stock threshold
    expect(body.availability.remaining).toBe(2);

    await asAdmin((tx) => tx.planNode.deleteMany({ where: { planId: plan.id } }));
    await prisma.plan.deleteMany({ where: { id: plan.id } });
    await prisma.node.deleteMany({ where: { id: roomy.id } });
    await redis.client.del('public:plans:v1');
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
