import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider.interface';
import { FakePaymentProvider } from './fake-payment-provider';

describe('Checkout (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let fakeProvider: FakePaymentProvider;
  let customerToken: string;
  let customerId: string;
  let intruderToken: string;
  let cardCustomerToken: string;
  let cardCustomerId: string;
  let planId: string;
  let limitedPlanId: string;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  function authed(token: string, url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${token}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(new FakePaymentProvider())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    fakeProvider = app.get(PAYMENT_PROVIDER);

    const staleRlKeys = await redis.client.keys('checkout_rl:*');
    if (staleRlKeys.length > 0) await redis.client.del(...staleRlKeys);

    const passwordHash = await argon2.hash('CheckoutPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `checkout-admin-${suffix}@gxhost.local`, username: `checkout-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const customer = await prisma.user.create({
      data: {
        email: `checkout-customer-${suffix}@gxhost.local`,
        username: `checkout-customer-${suffix}`,
        passwordHash,
        isActive: true,
        // Deliberately NOT '52998224725'/'11144477735' — those are the
        // exact CPFs subscriptions.e2e-spec.ts's own fixtures use, and
        // Jest runs spec files in parallel workers against the SAME
        // real Postgres: two files inserting the same CPF at once trips
        // the (correct) uniqueness constraint. This file's own fixtures
        // are algorithm-valid and used nowhere else in the test suite.
        cpf: '34567890175',
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    customerId = customer.id;
    await prisma.user.create({
      data: {
        email: `checkout-intruder-${suffix}@gxhost.local`,
        username: `checkout-intruder-${suffix}`,
        passwordHash,
        isActive: true,
        cpf: '98765432100',
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    const cardCustomer = await prisma.user.create({
      data: {
        email: `checkout-card-${suffix}@gxhost.local`,
        username: `checkout-card-${suffix}`,
        passwordHash,
        isActive: true,
        cpf: '48291356700',
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    cardCustomerId = cardCustomer.id;

    const customerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `checkout-customer-${suffix}@gxhost.local`, password: 'CheckoutPass!234567' } });
    customerToken = JSON.parse(customerLogin.body).accessToken;
    const intruderLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `checkout-intruder-${suffix}@gxhost.local`, password: 'CheckoutPass!234567' } });
    intruderToken = JSON.parse(intruderLogin.body).accessToken;
    const cardCustomerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `checkout-card-${suffix}@gxhost.local`, password: 'CheckoutPass!234567' } });
    cardCustomerToken = JSON.parse(cardCustomerLogin.body).accessToken;

    const plan = await prisma.plan.create({
      data: { name: `checkout-plan-${suffix}`, slug: `checkout-plan-${suffix}`, memoryMb: 2048, diskMb: 10240, priceCents: 5990, isPublic: true },
    });
    planId = plan.id;
    const limited = await prisma.plan.create({
      data: { name: `checkout-plan-limited-${suffix}`, slug: `checkout-plan-limited-${suffix}`, memoryMb: 1024, diskMb: 5120, priceCents: 990, isPublic: true, maxSlots: 1 },
    });
    limitedPlanId = limited.id;
  });

  afterAll(async () => {
    // Neither `orders` nor `payments` can be deleted by `app_user` —
    // DELETE is revoked from both entirely by design (0022_payments:
    // financial history is never deleted). Same convention every
    // existing spec already follows: test rows are simply left in
    // place, tied to the soft-deleted plan/user rows below.
    const cleanupSteps: Array<() => Promise<unknown>> = [
      () => asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscription: { planId: { in: [planId, limitedPlanId] } } } })),
      () => asAdmin((tx) => tx.subscription.deleteMany({ where: { planId: { in: [planId, limitedPlanId] } } })),
      () => prisma.plan.updateMany({ where: { id: { in: [planId, limitedPlanId] } }, data: { deletedAt: new Date() } }),
      () => prisma.user.updateMany({ where: { email: { contains: `checkout-` } }, data: { deletedAt: new Date() } }),
      async () => {
        const rlKeys = await redis.client.keys('checkout_rl:*');
        if (rlKeys.length > 0) await redis.client.del(...rlKeys);
      },
    ];
    for (const step of cleanupSteps) {
      await step().catch((err) => console.error('checkout.e2e-spec afterAll step failed (continuing):', err));
    }
    await app.close();
  });

  it('rejects an unauthenticated checkout attempt', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/client/checkout', payload: { planId, paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses checkout when the customer has no billing profile on file', async () => {
    const passwordHash = await argon2.hash('CheckoutPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const noBilling = await prisma.user.create({
      data: { email: `checkout-nobilling-${suffix}@gxhost.local`, username: `checkout-nobilling-${suffix}`, passwordHash, isActive: true },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: noBilling.email, password: 'CheckoutPass!234567' } });
    const token = JSON.parse(login.body).accessToken;

    const res = await authed(token, '/api/client/checkout', { method: 'POST', payload: { planId, paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('BILLING_PROFILE_REQUIRED');

    await prisma.user.updateMany({ where: { id: noBilling.id }, data: { deletedAt: new Date() } });
  });

  let orderId: string;
  let subscriptionId: string;

  it('creates a Pix order priced from the database, ignoring price/resource fields the frontend might send, with a QR code generated synchronously', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: {
        planId,
        paymentMethod: 'pix',
        // None of these exist on CreateCheckoutDto — the service only
        // ever reads planId/paymentMethod.
        amountCents: 1,
        priceCents: 1,
        memoryMb: 999999,
        maxSlots: 999,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    orderId = body.id;
    subscriptionId = body.subscriptionId;
    expect(body.status).toBe('pending');
    expect(body.kind).toBe('plan_initial');
    expect(body.amountCents).toBe(5990); // the plan's own priceCents, never the 1 sent above
    expect(body.currency).toBe('BRL');
    expect(body.paymentMethod).toBe('pix');
    expect(typeof body.pixQrCode).toBe('string');
    expect(body.pixQrCode.length).toBeGreaterThan(0);
    expect(body.pixQrCodeBase64).toBe('ZmFrZS1xci1wbmc=');
    expect(body.checkoutUrl).toBeNull(); // Pix never redirects
    expect(body.provisioningStatus).toBe('pending');
    expect(subscriptionId).toBeTruthy();

    const storedOrder: any = await asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: body.id } }));
    expect(storedOrder.userId).toBe(customerId);
    expect((fakeProvider.payments.get(`fake-pay-${body.externalReference}`)?.raw as { payerEmail?: string }).payerEmail)
      .toBe(`checkout-customer-${suffix}@gxhost.local`);

    const subscription: any = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }));
    // A pix subscription has NO provider-side object: Mercado Pago has
    // no recurring pix, so there is no preapproval to point at. The
    // charge is linked back by `externalReference` alone.
    expect(subscription.externalSubscriptionId).toBeNull();
    expect(subscription.status).toBe('pending'); // activation is exclusively the webhook's job
    expect(subscription.autoRenew).toBe(false); // pix never auto-renews — billing-cycle generates each cycle's charge
  });

  it('rejects browser-supplied ownership and reference fields', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: {
        planId,
        paymentMethod: 'pix',
        payerEmail: `checkout-customer-${suffix}@gxhost.local`,
        userId: cardCustomerId,
        orderId: '00000000-0000-0000-0000-000000000000',
        externalReference: 'attacker-controlled-reference',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a Pix checkout already recorded a payment row (pending), so the future webhook upserts instead of duplicating', async () => {
    const payment: any = await asAdmin((tx) => tx.payment.findFirst({ where: { orderId } }));
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('pending');
    expect(payment.paymentMethodId).toBe('pix');
  });

  it("card checkout returns Mercado Pago's own hosted authorization URL — no card data ever reaches this platform, and activation is exclusively the webhook's job", async () => {
    const res = await authed(cardCustomerToken, '/api/client/checkout', {
      method: 'POST',
      payload: { planId, paymentMethod: 'card', payerEmail: `third-party-${suffix}@outlook.com` },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('pending');
    expect(body.paymentMethod).toBe('card');
    expect(typeof body.checkoutUrl).toBe('string');
    expect(body.checkoutUrl.length).toBeGreaterThan(0);
    expect(body.pixQrCode).toBeNull();

    const subscription: any = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: body.subscriptionId } }));
    expect(subscription.externalSubscriptionId).toBe(`fake-preapproval-${body.externalReference}`);
    expect(subscription.status).toBe('pending');
    const storedOrder: any = await asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: body.id } }));
    expect(storedOrder.userId).toBe(cardCustomerId);
    expect((fakeProvider.subscriptions.get(subscription.externalSubscriptionId)?.raw as { payerEmail?: string }).payerEmail)
      .toBe(`third-party-${suffix}@outlook.com`);

    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscriptionId: subscription.id } }));
    await asAdmin((tx) => tx.order.update({ where: { id: body.id }, data: { subscriptionId: null, status: 'cancelled' } }));
    await asAdmin((tx) => tx.subscription.delete({ where: { id: subscription.id } }));
  });

  it('a provider failure creating the subscription fails the order immediately, instead of leaving it pending forever', async () => {
    fakeProvider.forceCreateChargeFailure = true;
    let res;
    try {
      res = await authed(cardCustomerToken, '/api/client/checkout', {
        method: 'POST',
        payload: { planId, paymentMethod: 'card' },
      });
    } finally {
      fakeProvider.forceCreateChargeFailure = false;
    }
    expect(res.statusCode).toBeGreaterThanOrEqual(500); // the provider failure propagates as an error response...
    // No serverName to key off of anymore (checkout no longer collects
    // one) — `cardCustomerId` + this plan + `status: 'failed'` is unique
    // within this file: no other test here ever drives an order for this
    // (user, plan) pair to `failed`.
    const orders: any[] = await asAdmin((tx) => tx.order.findMany({ where: { userId: cardCustomerId, planId, status: 'failed' } }));
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('failed'); // ...but the order it already created is never left dangling in 'pending'

    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscriptionId: orders[0].subscriptionId! } }));
    await asAdmin((tx) => tx.order.update({ where: { id: orders[0].id }, data: { subscriptionId: null, status: 'cancelled' } }));
    await asAdmin((tx) => tx.subscription.delete({ where: { id: orders[0].subscriptionId! } }));
  });

  it('the pending subscription behind the order was created through the normal subscribe path', async () => {
    const res = await authed(customerToken, `/api/client/subscriptions/${subscriptionId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('pending');
    expect(body.priceCents).toBe(5990);
    expect(body.serverId).toBeNull();
  });

  it("lists only the caller's own orders", async () => {
    const mine = await authed(customerToken, '/api/client/orders');
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.body).some((o: any) => o.id === orderId)).toBe(true);

    const intruders = await authed(intruderToken, '/api/client/orders');
    expect(JSON.parse(intruders.body).some((o: any) => o.id === orderId)).toBe(false);
  });

  it("404s (not 403) for another customer reading someone else's order", async () => {
    const res = await authed(intruderToken, `/api/client/orders/${orderId}`);
    expect(res.statusCode).toBe(404);
  });

  it('does not reserve maxSlots while two checkout attempts are still unpaid', async () => {
    const first = await authed(customerToken, '/api/client/checkout', { method: 'POST', payload: { planId: limitedPlanId, paymentMethod: 'pix' } });
    expect(first.statusCode).toBe(201);

    const second = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId: limitedPlanId, paymentMethod: 'pix' } });
    expect(second.statusCode).toBe(201);

    const pending = await asAdmin((tx) => tx.subscription.count({ where: { planId: limitedPlanId, status: 'pending', serverId: null } }));
    expect(pending).toBe(2);
  });

  it('a second checkout attempt for the same plan and SAME payment method while the first is still pending returns the SAME order (double-click idempotency, payments plan §24)', async () => {
    const first = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, paymentMethod: 'pix' } });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);

    const second = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, paymentMethod: 'pix' } });
    expect(second.statusCode).toBe(201);
    const secondBody = JSON.parse(second.body);

    expect(secondBody.id).toBe(firstBody.id); // the SAME order, not a new one
    expect(secondBody.subscriptionId).toBe(firstBody.subscriptionId);

    // Only ONE subscription for this plan was ever created across both calls.
    const matchingSubs: any[] = await asAdmin((tx) => tx.subscription.findMany({ where: { planId, id: firstBody.subscriptionId } }));
    expect(matchingSubs).toHaveLength(1);

    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscriptionId: firstBody.subscriptionId } }));
    await asAdmin((tx) => tx.order.update({ where: { id: firstBody.id }, data: { subscriptionId: null, status: 'cancelled' } }));
    await asAdmin((tx) => tx.subscription.delete({ where: { id: firstBody.subscriptionId } }));
  });

  it('switching payment method on a second checkout attempt cancels the stale order and starts a genuinely new one', async () => {
    const first = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, paymentMethod: 'pix' } });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.paymentMethod).toBe('pix');

    // Customer changed their mind: this must NOT hand back the old Pix
    // order's QR code under a "Cartão" click — that was the actual bug
    // report this test guards against.
    const second = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, paymentMethod: 'card' } });
    expect(second.statusCode).toBe(201);
    const secondBody = JSON.parse(second.body);

    expect(secondBody.id).not.toBe(firstBody.id);
    expect(secondBody.subscriptionId).not.toBe(firstBody.subscriptionId);
    expect(secondBody.paymentMethod).toBe('card');

    const staleOrder: any = await asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: firstBody.id } }));
    expect(staleOrder.status).toBe('cancelled');
    const staleSubscription: any = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: firstBody.subscriptionId } }));
    expect(staleSubscription.status).toBe('cancelled');

    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscriptionId: { in: [firstBody.subscriptionId, secondBody.subscriptionId] } } }));
    await asAdmin((tx) => tx.order.updateMany({ where: { id: { in: [firstBody.id, secondBody.id] } }, data: { subscriptionId: null, status: 'cancelled' } }));
    await asAdmin((tx) => tx.subscription.deleteMany({ where: { id: { in: [firstBody.subscriptionId, secondBody.subscriptionId] } } }));
  });
});
