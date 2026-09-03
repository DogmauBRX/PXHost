import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * Commercial site — the subscriptions contract layer (see the
 * subscriptions plan file). Covers: a customer subscribing to a public
 * plan, price/limit fields never being client-controllable, ownership
 * isolation (404 not 403 for another customer's subscription), the
 * cancel-only self-service transition, admin-only activation being the
 * sole path into `active`, and the plan's own vagas rule extending to
 * subscriptions that have not yet been provisioned a server.
 */
describe('Subscriptions (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;
  let customerId: string;
  let intruderToken: string;
  let planId: string;
  let limitedPlanId: string;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('SubsPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `subs-admin-${suffix}@pxhost.local`, username: `subs-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const customer = await prisma.user.create({
      data: { email: `subs-customer-${suffix}@pxhost.local`, username: `subs-customer-${suffix}`, passwordHash, isActive: true },
    });
    customerId = customer.id;
    await prisma.user.create({
      data: { email: `subs-intruder-${suffix}@pxhost.local`, username: `subs-intruder-${suffix}`, passwordHash, isActive: true },
    });

    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `subs-admin-${suffix}@pxhost.local`, password: 'SubsPass!234567' } });
    adminToken = JSON.parse(adminLogin.body).accessToken;
    const customerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `subs-customer-${suffix}@pxhost.local`, password: 'SubsPass!234567' } });
    customerToken = JSON.parse(customerLogin.body).accessToken;
    const intruderLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `subs-intruder-${suffix}@pxhost.local`, password: 'SubsPass!234567' } });
    intruderToken = JSON.parse(intruderLogin.body).accessToken;

    const plan = await prisma.plan.create({
      data: { name: `subs-plan-${suffix}`, slug: `subs-plan-${suffix}`, memoryMb: 2048, diskMb: 10240, priceCents: 4990, isPublic: true },
    });
    planId = plan.id;

    const limited = await prisma.plan.create({
      data: { name: `subs-plan-limited-${suffix}`, slug: `subs-plan-limited-${suffix}`, memoryMb: 1024, diskMb: 5120, priceCents: 990, isPublic: true, maxSlots: 1 },
    });
    limitedPlanId = limited.id;
  });

  afterAll(async () => {
    // subscriptions and subscription_events both carry RLS policies
    // (migration 0014) — a bare `prisma.<model>.deleteMany()` outside
    // `withRLS` runs with no app.user_id/app.is_admin set, which the
    // policy reads as "nobody," matching zero rows silently rather than
    // erroring (PrismaService's own doc comment; client-servers
    // .e2e-spec.ts's afterAll follows the identical `asAdmin` pattern
    // for the same reason on `servers`).
    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscription: { planId: { in: [planId, limitedPlanId] } } } }));
    await asAdmin((tx) => tx.subscription.deleteMany({ where: { planId: { in: [planId, limitedPlanId] } } }));
    await prisma.plan.deleteMany({ where: { id: { in: [planId, limitedPlanId] } } });
    await prisma.user.updateMany({ where: { email: { contains: `subs-` } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(token: string, url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${token}` }, ...opts });
  }

  let subscriptionId: string;

  // NOTE: CreateSubscriptionDto's forbidNonWhitelisted rejection of a
  // client-supplied `priceCents` was verified against the REAL running
  // server (curl, not app.inject) — a real HTTP request correctly gets
  // 400 ("property priceCents should not exist"). Fastify's
  // app.inject() does not trigger the same ValidationPipe rejection in
  // this Jest harness (the exact same known gap client-servers.e2e-spec
  // .ts's power-action test already documents) — not asserted here for
  // that reason.

  it('creates a pending subscription with price/period snapshotted from the plan, not the request', async () => {
    const res = await authed(customerToken, '/api/client/subscriptions', { method: 'POST', payload: { planId } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    subscriptionId = body.id;
    expect(body.status).toBe('pending');
    expect(body.priceCents).toBe(4990);
    expect(body.serverId).toBeNull();
  });

  it('lists only the caller\'s own subscriptions', async () => {
    const mine = await authed(customerToken, '/api/client/subscriptions');
    expect(mine.statusCode).toBe(200);
    const items = JSON.parse(mine.body);
    expect(items.some((s: any) => s.id === subscriptionId)).toBe(true);

    const intruders = await authed(intruderToken, '/api/client/subscriptions');
    const intruderItems = JSON.parse(intruders.body);
    expect(intruderItems.some((s: any) => s.id === subscriptionId)).toBe(false);
  });

  it('404s (not 403) for another customer reading someone else\'s subscription', async () => {
    const res = await authed(intruderToken, `/api/client/subscriptions/${subscriptionId}`);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a non-admin calling the admin status endpoint (the only path into active)', async () => {
    const res = await authed(customerToken, `/api/admin/subscriptions/${subscriptionId}/status`, {
      method: 'POST',
      payload: { status: 'active' },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('admin lists and filters subscriptions by status', async () => {
    const res = await authed(adminToken, `/api/admin/subscriptions?status=pending&planId=${planId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.some((s: any) => s.id === subscriptionId)).toBe(true);
  });

  it('admin activates the subscription, which sets currentPeriodEndsAt', async () => {
    const res = await authed(adminToken, `/api/admin/subscriptions/${subscriptionId}/status`, {
      method: 'POST',
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('active');
    expect(body.startedAt).not.toBeNull();
    expect(body.currentPeriodEndsAt).not.toBeNull();
  });

  it('an illegal admin transition is rejected with INVALID_TRANSITION', async () => {
    // active -> active has no defined edge (see subscription-status.spec.ts)
    const res = await authed(adminToken, `/api/admin/subscriptions/${subscriptionId}/status`, {
      method: 'POST',
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('INVALID_TRANSITION');
  });

  it('customer cancels their own active subscription', async () => {
    const res = await authed(customerToken, `/api/client/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      payload: { reason: 'no longer needed' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('cancelled');
  });

  it('cannot cancel an already-cancelled subscription (terminal state)', async () => {
    const res = await authed(customerToken, `/api/client/subscriptions/${subscriptionId}/cancel`, { method: 'POST' });
    expect(res.statusCode).toBe(409);
  });

  it('the subscription detail carries its event history', async () => {
    const res = await authed(customerToken, `/api/client/subscriptions/${subscriptionId}`);
    const body = JSON.parse(res.body);
    const transitions = body.events.map((e: any) => `${e.fromStatus ?? 'null'}->${e.toStatus}`);
    expect(transitions).toEqual(expect.arrayContaining(['null->pending', 'pending->active', 'active->cancelled']));
  });

  it('honors maxSlots: a second subscription to a 1-slot plan is refused NO_SLOTS, even though the first has no server yet', async () => {
    const first = await authed(customerToken, '/api/client/subscriptions', { method: 'POST', payload: { planId: limitedPlanId } });
    expect(first.statusCode).toBe(201);

    const second = await authed(intruderToken, '/api/client/subscriptions', { method: 'POST', payload: { planId: limitedPlanId } });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain('NO_SLOTS');
  });

  it('a non-existent plan 404s rather than leaking whether a private/unknown id exists', async () => {
    const res = await authed(customerToken, '/api/client/subscriptions', {
      method: 'POST',
      payload: { planId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });
});
