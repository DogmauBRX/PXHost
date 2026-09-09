import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { PaymentsWebhookService } from '../src/modules/payments/payments-webhook.service';
import {
  PAYMENT_PROVIDER,
  type CreateSubscriptionInput,
  type EnsureCustomerInput,
  type GatewayPayment,
  type GatewaySubscription,
  type InternalPaymentEvent,
  type ParsedWebhook,
  type PaymentProvider,
  type WebhookRequestInput,
} from '../src/modules/payments/payment-provider.interface';

/**
 * Same fake-provider convention `checkout.e2e-spec.ts` established, plus
 * `getPayment`/`getSubscription` standing in for Asaas's own re-fetch
 * endpoints — `PaymentsWebhookService.process` always re-fetches before
 * acting (the webhook body is never trusted), so each test seeds these
 * maps with the exact `GatewayPayment`/`GatewaySubscription` the "real"
 * API would have returned.
 *
 * `parseWebhook` here is intentionally NOT the real static-token check
 * (that's `AsaasProvider.parseWebhook`'s own responsibility) — gated on
 * a fake header, exactly precise enough to exercise
 * `PaymentsWebhookController`'s OWN responsibility (verify, dedupe,
 * enqueue, respond 2xx) in isolation from `PaymentsWebhookService`'s.
 */
class FakePaymentProvider implements PaymentProvider {
  readonly name = 'asaas';
  subscriptions = new Map<string, GatewaySubscription>();
  payments = new Map<string, GatewayPayment>();

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ externalCustomerId: string }> {
    return { externalCustomerId: `cus-${input.userId}` };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<GatewaySubscription> {
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
      paymentMethodId: 'PIX',
      installments: null,
      approvedAt: null,
      invoiceUrl: null,
      raw: {},
    });
    return subscription;
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    const sub = this.subscriptions.get(externalId);
    if (!sub) throw new Error(`test setup error: no fake subscription ${externalId}`);
    return sub;
  }

  async cancelSubscription(): Promise<never> {
    throw new Error('not exercised by this spec');
  }

  async listSubscriptionPayments(externalId: string): Promise<GatewayPayment[]> {
    return [...this.payments.values()].filter((p) => p.subscriptionExternalId === externalId);
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(externalId);
    if (!payment) throw new Error(`test setup error: no fake payment registered for id ${externalId}`);
    return payment;
  }

  async getPixQrCode(paymentId: string) {
    return { qrCode: `fake-qr-${paymentId}`, qrCodeBase64: 'ZmFrZS1xci1wbmc=', expiresAt: null };
  }

  async refund(): Promise<never> {
    throw new Error('not exercised by this spec');
  }

  parseWebhook(req: WebhookRequestInput): ParsedWebhook {
    if (req.headers['x-fake-token'] !== 'valid') {
      throw new UnauthorizedException('Invalid webhook token');
    }
    const body = (req.body ?? {}) as { id?: unknown; event?: unknown; payment?: { id?: unknown }; subscription?: { id?: unknown } };
    return {
      notificationId: body.id != null ? String(body.id) : '',
      rawEvent: body.event != null ? String(body.event) : '',
      internalEvent: 'Ignored',
      paymentExternalId: body.payment?.id != null ? String(body.payment.id) : null,
      subscriptionExternalId: body.subscription?.id != null ? String(body.subscription.id) : null,
    };
  }
}

function fakePayment(overrides: Partial<GatewayPayment> & { id: string; subscriptionExternalId: string; amountCents: number; status: string }): GatewayPayment {
  return {
    statusDetail: null,
    paidAmountCents: null,
    currency: 'BRL',
    paymentMethodId: 'PIX',
    installments: null,
    approvedAt: null,
    invoiceUrl: null,
    raw: {},
    ...overrides,
  };
}

/**
 * `PaymentsWebhookService.process` — the actual business logic run by
 * the `webhook-processing` queue's worker, which never runs in these
 * e2e tests (the worker is a separate process, `src/worker.ts`, same
 * "no e2e precedent for driving a queue end-to-end" posture
 * `provisioning.e2e-spec.ts` already established). Called DIRECTLY via
 * DI here — a `ParsedWebhook` built by hand stands in for what the
 * controller would have enqueued, letting these tests exercise the
 * exact same code the worker runs without needing BullMQ actually
 * running. `PaymentsWebhookController` itself (verify → dedupe →
 * enqueue → 200) is covered separately, in its own describe block
 * below, over real HTTP.
 */
describe('Payments webhook processing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let webhookService: PaymentsWebhookService;
  let fakeProvider: FakePaymentProvider;
  let customerToken: string;
  let planId: string;
  let templateId: string;
  let groupId: string;
  const suffix = Date.now();
  let eventCounter = 0;

  function asAdmin(fn: (tx: any) => Promise<any>): Promise<any> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  function nextNotificationId(): string {
    eventCounter += 1;
    return `evt-${suffix}-${eventCounter}`;
  }

  function parsedPaymentEvent(internalEvent: InternalPaymentEvent, paymentExternalId: string, notificationId = nextNotificationId()): ParsedWebhook {
    return { notificationId, rawEvent: internalEvent, internalEvent, paymentExternalId, subscriptionExternalId: null };
  }

  function parsedSubscriptionEvent(internalEvent: InternalPaymentEvent, subscriptionExternalId: string, notificationId = nextNotificationId()): ParsedWebhook {
    return { notificationId, rawEvent: internalEvent, internalEvent, paymentExternalId: null, subscriptionExternalId };
  }

  /** Every processed webhook writes a `payment_webhook_events` row for dedupe bookkeeping (`markEvent`) — tests call this directly since `process()` itself doesn't insert that row (the CONTROLLER does, before enqueuing; see the controller's own describe block below). Inserted here to let `process()`'s own idempotency-relevant behavior (re-marking `processed`/`failed`) be observed. */
  async function seedWebhookEventRow(notificationId: string): Promise<void> {
    await prisma.paymentWebhookEvent.create({ data: { id: notificationId, provider: 'asaas', type: 'test', raw: {} } });
  }

  async function createOrder(): Promise<{ orderId: string; subscriptionId: string; amountCents: number; paymentExternalId: string; subscriptionExternalId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, templateId, serverName: `srv-${Math.random().toString(36).slice(2)}`, paymentMethod: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const subscriptionExternalId = `fake-sub-${body.externalReference}`;
    const paymentExternalId = `fake-pay-${body.externalReference}`;
    return { orderId: body.id, subscriptionId: body.subscriptionId, amountCents: body.amountCents, paymentExternalId, subscriptionExternalId };
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
    webhookService = app.get(PaymentsWebhookService);

    const staleRlKeys = await redis.client.keys('checkout_rl:*');
    if (staleRlKeys.length > 0) await redis.client.del(...staleRlKeys);

    const passwordHash = await argon2.hash('WebhookPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: {
        email: `webhook-customer-${suffix}@gxhost.local`,
        username: `webhook-customer-${suffix}`,
        passwordHash,
        isActive: true,
        cpf: '14725836982',
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `webhook-customer-${suffix}@gxhost.local`, password: 'WebhookPass!234567' } });
    customerToken = JSON.parse(login.body).accessToken;

    const plan = await prisma.plan.create({
      data: { name: `webhook-plan-${suffix}`, slug: `webhook-plan-${suffix}`, memoryMb: 2048, diskMb: 10240, priceCents: 4990, isPublic: true },
    });
    planId = plan.id;

    const group = await prisma.templateGroup.create({ data: { name: `webhook-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `webhook-template-${suffix}`,
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        isActive: true,
        isPublic: true,
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    // orders/payments/payment_webhook_events are all DELETE-revoked by
    // design (0022_payments) — same convention checkout.e2e-spec.ts's
    // own afterAll already established: leave them, clean up everything
    // else.
    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscription: { planId } } }));
    await asAdmin((tx) => tx.subscription.deleteMany({ where: { planId } }));
    await prisma.plan.updateMany({ where: { id: planId }, data: { deletedAt: new Date() } });
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.delete({ where: { id: groupId } });
    await prisma.user.updateMany({ where: { email: { contains: 'webhook-' } }, data: { deletedAt: new Date() } });
    const rlKeys = await redis.client.keys('checkout_rl:*');
    if (rlKeys.length > 0) await redis.client.del(...rlKeys);
    await app.close();
  });

  it('a confirmed payment activates the order and the subscription', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED', paidAmountCents: amountCents, approvedAt: new Date() }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
    expect(order?.paidAmountCents).toBe(amountCents);

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');
    expect(subscription?.autoRenew).toBe(true);
    expect(subscription?.currentPeriodEndsAt).not.toBeNull();

    const payment = await prisma.payment.findUnique({ where: { id: paymentExternalId } });
    expect(payment?.status).toBe('CONFIRMED');
    expect(payment?.orderId).toBe(orderId);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed');
  });

  it('redelivering the exact same notification is an idempotent no-op', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    const parsed = parsedPaymentEvent('PaymentConfirmed', paymentExternalId, notificationId);
    await webhookService.process(parsed);
    await webhookService.process(parsed); // exact same notification — a retried BullMQ job, or a redelivery

    const events = await asAdmin((tx) => tx.subscriptionEvent.findMany({ where: { subscriptionId } }));
    expect(events.filter((e: any) => e.toStatus === 'active')).toHaveLength(1);

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
  });

  it('a SECOND, different notification about an already-paid order is also a no-op (order-status guard, not just notification-id dedup)', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));

    const first = nextNotificationId();
    await seedWebhookEventRow(first);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, first));

    // A DIFFERENT notification id about the SAME underlying payment —
    // Asaas's own at-least-once delivery can produce this (e.g.
    // PAYMENT_CREATED then PAYMENT_CONFIRMED for one payment id).
    const second = nextNotificationId();
    await seedWebhookEventRow(second);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, second));

    const events = await asAdmin((tx) => tx.subscriptionEvent.findMany({ where: { subscriptionId } }));
    expect(events.filter((e: any) => e.toStatus === 'active')).toHaveLength(1);
    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
  });

  it('a payment whose subscription this platform has no record of is acknowledged with no effect', async () => {
    const paymentExternalId = `fake-pay-orphan-${suffix}`;
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId: 'fake-sub-does-not-exist', amountCents: 1000, status: 'CONFIRMED' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, notificationId));

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed'); // acknowledged (an audit entry is recorded), never retried forever
  });

  it('an "Ignored" internal event is a pure no-op', async () => {
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process({ notificationId, rawEvent: 'PAYMENT_CHECKOUT_VIEWED', internalEvent: 'Ignored', paymentExternalId: null, subscriptionExternalId: null });
    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed');
  });

  it('an amount mismatch never activates the order', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents: amountCents - 100, status: 'CONFIRMED' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('pending');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('pending');
  });

  it('a payment stuck PENDING never activates the order; the later CONFIRMED notification does', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    // PENDING isn't in the payment-shaped event set at all — no
    // PaymentPending case reaches processPaymentEvent; simulate via the
    // 'PaymentPending' internal event directly (maps from
    // PAYMENT_AWAITING_RISK_ANALYSIS/PAYMENT_UPDATED/etc.).
    const holdNotification = nextNotificationId();
    await seedWebhookEventRow(holdNotification);
    await webhookService.process({ notificationId: holdNotification, rawEvent: 'PAYMENT_UPDATED', internalEvent: 'PaymentPending', paymentExternalId, subscriptionExternalId: null });
    let order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('pending');

    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));
    const confirmNotification = nextNotificationId();
    await seedWebhookEventRow(confirmNotification);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, confirmNotification));

    order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');
  });

  it('a failed payment marks the order failed but leaves the subscription pending', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'REPROVED_BY_RISK_ANALYSIS' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentFailed', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('failed');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('pending'); // never active — a failed payment must never activate anything
  });

  it('a renewal charge going overdue moves the subscription to past_due WITHOUT suspending it — billing-cycle owns suspension, not the webhook', async () => {
    const { subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, nextNotificationId()));

    // A real Asaas payment never reverts CONFIRMED -> OVERDUE — what
    // actually goes overdue is a DIFFERENT, later charge the subscription
    // scheduler generated on its own (a brand new payment id, same
    // subscription).
    const renewalPaymentId = `fake-pay-renewal-overdue-${subscriptionExternalId}`;
    fakeProvider.payments.set(renewalPaymentId, fakePayment({ id: renewalPaymentId, subscriptionExternalId, amountCents, status: 'OVERDUE' }));
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentOverdue', renewalPaymentId, notificationId));

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('past_due');
  });

  it('a refunded payment on an already-paid order suspends the active subscription', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, nextNotificationId()));
    let subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');

    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'REFUNDED' }));
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentRefunded', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('refunded');
    subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('suspended');
  });

  it("a renewal charge Asaas generates on its own creates a NEW plan_renewal order and extends the subscription's period", async () => {
    const { subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, nextNotificationId()));

    const beforeRenewal: any = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(beforeRenewal.status).toBe('active');

    // A brand new payment id — Asaas's scheduler generated this on its
    // own, with no `Order` behind it yet at all.
    const renewalPaymentId = `fake-pay-renewal-${suffix}`;
    fakeProvider.payments.set(renewalPaymentId, fakePayment({ id: renewalPaymentId, subscriptionExternalId, amountCents, status: 'CONFIRMED', approvedAt: new Date() }));
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', renewalPaymentId, notificationId));

    const renewalOrder: any = await asAdmin((tx) => tx.order.findFirst({ where: { subscriptionId, kind: 'plan_renewal' } }));
    expect(renewalOrder).not.toBeNull();
    expect(renewalOrder.status).toBe('paid');
    expect(renewalOrder.provisioningStatus).toBe('not_required'); // the server already exists

    const afterRenewal: any = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(afterRenewal.status).toBe('active');
    expect(new Date(afterRenewal.currentPeriodEndsAt).getTime()).toBeGreaterThan(new Date(beforeRenewal.currentPeriodEndsAt).getTime());

    const renewalPayment = await prisma.payment.findUnique({ where: { id: renewalPaymentId } });
    expect(renewalPayment?.orderId).toBe(renewalOrder.id);
  });

  it('a subscription-canceled notification cancels the subscription', async () => {
    const { subscriptionId, amountCents, paymentExternalId, subscriptionExternalId } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, subscriptionExternalId, amountCents, status: 'CONFIRMED' }));
    await webhookService.process(parsedPaymentEvent('PaymentConfirmed', paymentExternalId, nextNotificationId()));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(parsedSubscriptionEvent('SubscriptionCanceled', subscriptionExternalId, notificationId));

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('cancelled');
  });
});

/**
 * `PaymentsWebhookController` itself — its own, much smaller job: verify
 * the token, dedupe-insert, enqueue, respond 2xx. Never runs
 * `PaymentsWebhookService.process` synchronously (see this file's own
 * top-of-file doc comment) — the worker that would is never started by
 * these tests, so a `payment_webhook_events` row created via this path
 * stays `status: 'received'` (never `processed`) for the lifetime of
 * this suite, which is itself the behavior under test.
 */
describe('Payments webhook controller (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const suffix = Date.now();

  function webhookPost(body: unknown, token: string | null = 'valid') {
    return app.inject({
      method: 'POST',
      url: '/api/webhooks/asaas',
      headers: token !== null ? { 'x-fake-token': token } : {},
      payload: body as Record<string, unknown>,
    });
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a webhook with an invalid token, and records nothing', async () => {
    const notificationId = `evt-badtoken-${suffix}`;
    const res = await webhookPost({ id: notificationId, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay-x' } }, 'wrong-token');
    expect(res.statusCode).toBe(401);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event).toBeNull();
  });

  it('a valid webhook is recorded and enqueued, responding 200 without processing it synchronously', async () => {
    const notificationId = `evt-valid-${suffix}`;
    const res = await webhookPost({ id: notificationId, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay-x' } });
    expect(res.statusCode).toBe(200);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event).not.toBeNull();
    expect(event?.provider).toBe('asaas');
    expect(event?.status).toBe('received'); // never 'processed' here — no worker is running in this test process
  });

  it('a redelivered notification (same id) is still 200, without a second event row', async () => {
    const notificationId = `evt-redeliver-${suffix}`;
    const first = await webhookPost({ id: notificationId, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay-y' } });
    expect(first.statusCode).toBe(200);
    const second = await webhookPost({ id: notificationId, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay-y' } });
    expect(second.statusCode).toBe(200);

    const count = await prisma.paymentWebhookEvent.count({ where: { id: notificationId } });
    expect(count).toBe(1);
  });
});
