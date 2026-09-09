import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import {
  PAYMENT_PROVIDER,
  type CreateSubscriptionInput,
  type EnsureCustomerInput,
  type GatewayPayment,
  type GatewaySubscription,
  type PaymentProvider,
} from '../src/modules/payments/payment-provider.interface';

/**
 * `ASAAS_API_KEY` is unset in this test environment (correctly — no test
 * should ever call the real Asaas API), so `OrdersService` is pointed at
 * this fake instead, via `overrideProvider(PAYMENT_PROVIDER)` — the
 * mocking convention this suite established back in the Mercado Pago
 * era, carried forward unchanged.
 *
 * Asaas migration shape: EVERY checkout (Pix or card) creates a
 * recurring subscription and returns its FIRST charge synchronously —
 * a Pix QR shown in-page, or a `checkoutUrl` (Asaas's own hosted
 * checkout, "checkout hospedado" decision) for card. There is no more
 * synchronous card-token rejection at checkout time: a card is only
 * ever accepted/declined on Asaas's OWN page, which arrives later via
 * webhook (covered by payments-webhook.e2e-spec.ts, not this file) —
 * this file only covers what happens before that point.
 */
class FakePaymentProvider implements PaymentProvider {
  readonly name = 'asaas';
  subscriptions = new Map<string, GatewaySubscription>();
  payments = new Map<string, GatewayPayment>();
  /** Set by a test right before the checkout call to simulate Asaas being unreachable/erroring on subscription creation — reset immediately after, same "explicit flag, not a magic string" pattern the rest of this fake follows. */
  forceCreateSubscriptionFailure = false;

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ externalCustomerId: string }> {
    return { externalCustomerId: `cus-${input.userId}` };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<GatewaySubscription> {
    if (this.forceCreateSubscriptionFailure) {
      throw new Error('simulated Asaas failure');
    }
    const id = `fake-sub-${input.externalReference}`;
    const subscription: GatewaySubscription = { id, status: 'ACTIVE', externalReference: input.externalReference, nextDueDate: input.firstDueDate, raw: {} };
    this.subscriptions.set(id, subscription);

    const paymentId = `fake-pay-${input.externalReference}`;
    this.payments.set(paymentId, {
      id: paymentId,
      status: 'PENDING',
      statusDetail: null,
      subscriptionExternalId: id,
      amountCents: input.amountCents,
      paidAmountCents: null,
      currency: input.currency,
      paymentMethodId: input.paymentMethod === 'pix' ? 'PIX' : 'CREDIT_CARD',
      installments: null,
      approvedAt: null,
      invoiceUrl: input.paymentMethod === 'card' ? `https://fake.asaas.test/i/${paymentId}` : null,
      raw: {},
    });
    return subscription;
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    const sub = this.subscriptions.get(externalId);
    if (!sub) throw new Error(`test setup error: no fake subscription ${externalId}`);
    return sub;
  }

  async cancelSubscription(externalId: string): Promise<void> {
    const sub = this.subscriptions.get(externalId);
    if (sub) this.subscriptions.set(externalId, { ...sub, status: 'INACTIVE' });
  }

  async listSubscriptionPayments(externalId: string): Promise<GatewayPayment[]> {
    return [...this.payments.values()].filter((p) => p.subscriptionExternalId === externalId);
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(externalId);
    if (!payment) throw new Error(`test setup error: no fake payment ${externalId}`);
    return payment;
  }

  async getPixQrCode(paymentId: string) {
    return { qrCode: `fake-qr-copy-paste-${paymentId}`, qrCodeBase64: 'ZmFrZS1xci1wbmc=', expiresAt: null };
  }

  async refund(): Promise<never> {
    throw new Error('not exercised by this spec');
  }

  parseWebhook(): never {
    throw new Error('not exercised by this spec');
  }
}

/**
 * Checkout order creation — covers: price/period always read from the
 * database (never the request body), template eligibility (must exist,
 * be active, be public), variable validation (rules + isUserEditable)
 * reusing the same enforcement the client variables endpoint already
 * has, ownership isolation, maxSlots holding under a checkout exactly
 * like it already does under a plain subscribe, and the double-click
 * idempotency guard (payments plan §24).
 */
describe('Checkout (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let fakeProvider: FakePaymentProvider;
  let customerToken: string;
  let intruderToken: string;
  let cardCustomerToken: string;
  let planId: string;
  let limitedPlanId: string;
  let groupId: string;
  let templateId: string;
  let privateTemplateId: string;
  let inactiveTemplateId: string;
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
    await prisma.user.create({
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
    await prisma.user.create({
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

    const group = await prisma.templateGroup.create({ data: { name: `checkout-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `checkout-template-${suffix}`,
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        isActive: true,
        isPublic: true,
        variables: {
          create: [
            { name: 'Minecraft Version', envVariable: 'MINECRAFT_VERSION', defaultValue: 'latest', rules: 'required|string|max:16', isUserViewable: true, isUserEditable: true, sortOrder: 0 },
            { name: 'Server Memory', envVariable: 'SERVER_MEMORY', defaultValue: '1024', rules: 'required|integer|min:512', isUserViewable: true, isUserEditable: false, sortOrder: 1 },
          ],
        },
      },
    });
    templateId = template.id;
    const privateTemplate = await prisma.serverTemplate.create({
      data: { groupId, name: `checkout-private-${suffix}`, author: 'test', dockerImages: { x: 'y' }, startupCommand: 'x', installScript: 'x', isActive: true, isPublic: false },
    });
    privateTemplateId = privateTemplate.id;
    const inactiveTemplate = await prisma.serverTemplate.create({
      data: { groupId, name: `checkout-inactive-${suffix}`, author: 'test', dockerImages: { x: 'y' }, startupCommand: 'x', installScript: 'x', isActive: false, isPublic: true },
    });
    inactiveTemplateId = inactiveTemplate.id;
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
      () => prisma.templateVariable.deleteMany({ where: { templateId } }),
      () => prisma.serverTemplate.deleteMany({ where: { id: { in: [templateId, privateTemplateId, inactiveTemplateId] } } }),
      () => prisma.templateGroup.delete({ where: { id: groupId } }),
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
    const res = await app.inject({ method: 'POST', url: '/api/client/checkout', payload: { planId, templateId, serverName: 'srv', paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses checkout when the customer has no billing profile on file', async () => {
    const passwordHash = await argon2.hash('CheckoutPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const noBilling = await prisma.user.create({
      data: { email: `checkout-nobilling-${suffix}@gxhost.local`, username: `checkout-nobilling-${suffix}`, passwordHash, isActive: true },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: noBilling.email, password: 'CheckoutPass!234567' } });
    const token = JSON.parse(login.body).accessToken;

    const res = await authed(token, '/api/client/checkout', { method: 'POST', payload: { planId, templateId, serverName: 'srv', paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('BILLING_PROFILE_REQUIRED');

    await prisma.user.updateMany({ where: { id: noBilling.id }, data: { deletedAt: new Date() } });
  });

  it('a non-existent template 404s', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: { planId, templateId: '00000000-0000-0000-0000-000000000000', serverName: 'srv', paymentMethod: 'pix' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a template that is not public', async () => {
    const res = await authed(customerToken, '/api/client/checkout', { method: 'POST', payload: { planId, templateId: privateTemplateId, serverName: 'srv', paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a template that is not active', async () => {
    const res = await authed(customerToken, '/api/client/checkout', { method: 'POST', payload: { planId, templateId: inactiveTemplateId, serverName: 'srv', paymentMethod: 'pix' } });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a variable value that fails its own rules', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: { planId, templateId, serverName: 'srv', paymentMethod: 'pix', variables: { MINECRAFT_VERSION: 'x'.repeat(20) } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects overriding a variable the template marks non-editable', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: { planId, templateId, serverName: 'srv', paymentMethod: 'pix', variables: { SERVER_MEMORY: '99999' } },
    });
    expect(res.statusCode).toBe(403);
  });

  let orderId: string;
  let subscriptionId: string;

  it('creates a Pix order priced from the database, ignoring price/resource fields the frontend might send, with a QR code generated synchronously', async () => {
    const res = await authed(customerToken, '/api/client/checkout', {
      method: 'POST',
      payload: {
        planId,
        templateId,
        serverName: 'meu-servidor',
        paymentMethod: 'pix',
        variables: { MINECRAFT_VERSION: '1.21.1' },
        // None of these exist on CreateCheckoutDto — the service only
        // ever reads planId/templateId/serverName/variables/paymentMethod.
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

    const subscription: any = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }));
    expect(subscription.externalSubscriptionId).toBe(`fake-sub-${body.externalReference}`);
    expect(subscription.status).toBe('pending'); // activation is exclusively the webhook's job, even though the provider subscription itself already exists
  });

  it('a Pix checkout already recorded a payment row (pending), so the future webhook upserts instead of duplicating', async () => {
    const payment: any = await asAdmin((tx) => tx.payment.findFirst({ where: { orderId } }));
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('PENDING');
    expect(payment.paymentMethodId).toBe('PIX');
  });

  it('card checkout returns Asaas\'s own hosted checkout URL — no card data ever reaches this platform, and activation is exclusively the webhook\'s job', async () => {
    const res = await authed(cardCustomerToken, '/api/client/checkout', {
      method: 'POST',
      payload: { planId, templateId, serverName: 'meu-servidor-cartao', paymentMethod: 'card' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('pending');
    expect(body.paymentMethod).toBe('card');
    expect(typeof body.checkoutUrl).toBe('string');
    expect(body.checkoutUrl.length).toBeGreaterThan(0);
    expect(body.pixQrCode).toBeNull();

    const subscription: any = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: body.subscriptionId } }));
    expect(subscription.externalSubscriptionId).toBe(`fake-sub-${body.externalReference}`);
    expect(subscription.status).toBe('pending');

    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscriptionId: subscription.id } }));
    await asAdmin((tx) => tx.order.update({ where: { id: body.id }, data: { subscriptionId: null, status: 'cancelled' } }));
    await asAdmin((tx) => tx.subscription.delete({ where: { id: subscription.id } }));
  });

  it('a provider failure creating the subscription fails the order immediately, instead of leaving it pending forever', async () => {
    // Suffix-unique, not a bare literal: `orders` can never be deleted
    // (DELETE revoked, 0022_payments), so a re-run of this exact test
    // leaves the PREVIOUS run's order behind forever — a literal
    // serverName would make the lookup below match every one of them.
    const providerErrorServerName = `meu-servidor-erro-provider-${suffix}`;
    fakeProvider.forceCreateSubscriptionFailure = true;
    let res;
    try {
      res = await authed(cardCustomerToken, '/api/client/checkout', {
        method: 'POST',
        payload: { planId, templateId, serverName: providerErrorServerName, paymentMethod: 'card' },
      });
    } finally {
      fakeProvider.forceCreateSubscriptionFailure = false;
    }
    expect(res.statusCode).toBeGreaterThanOrEqual(500); // the provider failure propagates as an error response...
    const orders: any[] = await asAdmin((tx) => tx.order.findMany({ where: { config: { path: ['serverName'], equals: providerErrorServerName } } }));
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

  it('honors maxSlots at checkout: a second checkout against a 1-slot plan is refused NO_SLOTS', async () => {
    const first = await authed(customerToken, '/api/client/checkout', { method: 'POST', payload: { planId: limitedPlanId, templateId, serverName: 'a', paymentMethod: 'pix' } });
    expect(first.statusCode).toBe(201);

    const second = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId: limitedPlanId, templateId, serverName: 'b', paymentMethod: 'pix' } });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain('NO_SLOTS');
  });

  it('a second checkout attempt for the same plan while the first is still pending returns the SAME order (double-click idempotency, payments plan §24)', async () => {
    const first = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, templateId, serverName: 'dup-1', paymentMethod: 'pix' } });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);

    const second = await authed(intruderToken, '/api/client/checkout', { method: 'POST', payload: { planId, templateId, serverName: 'dup-2', paymentMethod: 'card' } });
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
});
