import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { OrdersService } from '../src/modules/payments/orders.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider.interface';
import { FakePaymentProvider } from './fake-payment-provider';

/**
 * Pix renewal — the half of billing Mercado Pago does NOT do for us.
 * `/preapproval` is card-only, so for pix this platform is the
 * scheduler: `OrdersService.createPixRenewalCharge` creates each cycle's
 * order and charge, and an unpaid one expiring is what makes the
 * subscription delinquent (no provider event exists to tell us).
 *
 * `createPixRenewalCharge` is called DIRECTLY here rather than through
 * `BillingCycleProcessor`'s daily BullMQ job — same "no e2e precedent
 * for driving a queue end-to-end" posture `provisioning.e2e-spec.ts`
 * established. The processor's own job is just to find due
 * subscriptions and call this.
 */
describe('Pix renewal charges (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let orders: OrdersService;
  let fakeProvider: FakePaymentProvider;
  let customerToken: string;
  let planId: string;
  const suffix = Date.now();

  function asAdmin(fn: (tx: any) => Promise<any>): Promise<any> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  /** Checks out with pix, then puts the subscription in the state a renewal actually happens from: active, with its period about to end. */
  async function activeSubscriptionDueForRenewal(): Promise<{ subscriptionId: string; orderId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, paymentMethod: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    await asAdmin((tx) =>
      tx.subscription.update({
        where: { id: body.subscriptionId },
        data: { status: 'active', startedAt: new Date(), currentPeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      }),
    );
    await asAdmin((tx) => tx.order.update({ where: { id: body.id }, data: { status: 'paid', paidAt: new Date() } }));
    return { subscriptionId: body.subscriptionId, orderId: body.id };
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
    orders = app.get(OrdersService);
    fakeProvider = app.get(PAYMENT_PROVIDER);

    const staleRlKeys = await redis.client.keys('checkout_rl:*');
    if (staleRlKeys.length > 0) await redis.client.del(...staleRlKeys);

    const passwordHash = await argon2.hash('RenewalPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: {
        email: `renewal-customer-${suffix}@gxhost.local`,
        username: `renewal-customer-${suffix}`,
        passwordHash,
        isActive: true,
        // Keep test fixture data distinct across runs for easier inspection.
        cpf: String(suffix).slice(-11),
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `renewal-customer-${suffix}@gxhost.local`, password: 'RenewalPass!234567' },
    });
    customerToken = JSON.parse(login.body).accessToken;

    const plan = await prisma.plan.create({
      data: { name: `renewal-plan-${suffix}`, slug: `renewal-plan-${suffix}`, memoryMb: 2048, diskMb: 10240, priceCents: 4990, isPublic: true },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    // orders/payments are DELETE-revoked by design (0022_payments) —
    // same convention the other payments specs follow: leave them,
    // clean up everything else.
    // The user is SOFT-deleted, never removed: deleting it would cascade
    // onto `audit_logs`, which is append-only at the database level
    // ("audit_logs is append-only: UPDATE is not permitted"). Same
    // convention checkout.e2e-spec.ts's own afterAll follows, including
    // never failing the suite over a cleanup step.
    const cleanupSteps: Array<() => Promise<unknown>> = [
      () => asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscription: { planId } } })),
      () => asAdmin((tx) => tx.order.updateMany({ where: { planId }, data: { subscriptionId: null, status: 'cancelled' } })),
      () => asAdmin((tx) => tx.subscription.deleteMany({ where: { planId } })),
      () => prisma.plan.updateMany({ where: { id: planId }, data: { deletedAt: new Date() } }),
      () => prisma.user.updateMany({ where: { email: `renewal-customer-${suffix}@gxhost.local` }, data: { deletedAt: new Date() } }),
      async () => {
        const rlKeys = await redis.client.keys('checkout_rl:*');
        if (rlKeys.length > 0) await redis.client.del(...rlKeys);
      },
    ];
    for (const step of cleanupSteps) {
      await step().catch((err) => console.error('billing-renewal.e2e-spec afterAll step failed (continuing):', err));
    }
    await app.close();
  });

  it("creates the next cycle's order and Pix charge, priced from the SUBSCRIPTION's snapshot", async () => {
    const { subscriptionId } = await activeSubscriptionDueForRenewal();

    const renewalOrderId = await orders.createPixRenewalCharge(subscriptionId);
    expect(renewalOrderId).not.toBeNull();

    const order: any = await asAdmin((tx) => tx.order.findUnique({ where: { id: renewalOrderId! } }));
    expect(order.kind).toBe('plan_renewal');
    expect(order.status).toBe('pending');
    expect(order.amountCents).toBe(4990);
    expect(order.paymentMethod).toBe('pix');
    // The server already exists — a renewal only extends the period.
    expect(order.provisioningStatus).toBe('not_required');
    // The QR is captured at creation, not fetched later.
    expect(typeof order.pixQrCode).toBe('string');
    expect(order.pixQrCodeBase64).toBe('ZmFrZS1xci1wbmc=');

    const payment: any = await asAdmin((tx) => tx.payment.findFirst({ where: { orderId: order.id } }));
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('pending');
  });

  it('running the job twice does NOT create a second charge for the same cycle', async () => {
    const { subscriptionId } = await activeSubscriptionDueForRenewal();

    const first = await orders.createPixRenewalCharge(subscriptionId);
    expect(first).not.toBeNull();

    // The daily job WILL run again before the customer pays.
    const second = await orders.createPixRenewalCharge(subscriptionId);
    expect(second).toBeNull();

    const renewalOrders = await asAdmin((tx) => tx.order.findMany({ where: { subscriptionId, kind: 'plan_renewal' } }));
    expect(renewalOrders).toHaveLength(1);
  });

  it('refuses to charge a CARD subscription — Mercado Pago already schedules those itself', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, paymentMethod: 'card' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    await asAdmin((tx) =>
      tx.subscription.update({
        where: { id: body.subscriptionId },
        data: { status: 'active', currentPeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      }),
    );

    expect(await orders.createPixRenewalCharge(body.subscriptionId)).toBeNull();
    const renewalOrders = await asAdmin((tx) => tx.order.findMany({ where: { subscriptionId: body.subscriptionId, kind: 'plan_renewal' } }));
    expect(renewalOrders).toHaveLength(0);

    // This order stays `pending`, and checkout's own duplicate guard
    // would hand it back to the NEXT test's pix checkout (same user,
    // same plan) — which would then be a card subscription and quietly
    // change what that test is testing. Close it out here.
    await asAdmin((tx) => tx.order.update({ where: { id: body.id }, data: { status: 'cancelled' } }));
  });

  it('leaves the order failed (not pending) when Mercado Pago rejects the charge, so the next run can retry', async () => {
    const { subscriptionId } = await activeSubscriptionDueForRenewal();

    fakeProvider.forceCreateChargeFailure = true;
    try {
      await expect(orders.createPixRenewalCharge(subscriptionId)).rejects.toThrow();
    } finally {
      fakeProvider.forceCreateChargeFailure = false;
    }

    const failed = await asAdmin((tx) => tx.order.findMany({ where: { subscriptionId, kind: 'plan_renewal', status: 'failed' } }));
    expect(failed).toHaveLength(1);

    // A failed order does not block the retry — the duplicate guard only
    // counts PENDING ones.
    const retried = await orders.createPixRenewalCharge(subscriptionId);
    expect(retried).not.toBeNull();
  });
});
