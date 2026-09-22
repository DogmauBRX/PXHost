import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { PaymentsWebhookService } from '../src/modules/payments/payments-webhook.service';
import { PAYMENT_PROVIDER, type GatewayPayment, type ParsedWebhook } from '../src/modules/payments/payment-provider.interface';
import { FakePaymentProvider } from './fake-payment-provider';

/**
 * A pix-shaped charge: it belongs to no preapproval, so `externalReference`
 * (the id THIS platform generated for the order) is the only thing that
 * links it back — exactly how a real Mercado Pago pix payment behaves.
 */
function fakePayment(overrides: Partial<GatewayPayment> & { id: string; externalReference: string; amountCents: number; status: string }): GatewayPayment {
  return {
    statusDetail: null,
    subscriptionExternalId: null,
    paidAmountCents: null,
    currency: 'BRL',
    paymentMethodId: 'pix',
    paymentTypeId: 'bank_transfer',
    installments: null,
    approvedAt: null,
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
  let customerId: string;
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

  /**
   * Drives a notification the way Mercado Pago actually does it: put the
   * CHARGE into the status that produces the outcome, then notify about
   * the resource id. The notification itself carries no outcome — the
   * service re-fetches and classifies, exactly as in production.
   */
  function paymentNotification(status: string, paymentExternalId: string, notificationId = nextNotificationId()): ParsedWebhook {
    fakeProvider.setPaymentStatus(paymentExternalId, status);
    return { notificationId, rawEvent: 'payment.updated', resourceKind: 'payment', resourceId: paymentExternalId };
  }

  /** Same, for a notification about a charge Mercado Pago generated itself for a card subscription. */
  function recurringChargeNotification(paymentExternalId: string, notificationId = nextNotificationId()): ParsedWebhook {
    return { notificationId, rawEvent: 'payment.updated', resourceKind: 'authorized_payment', resourceId: paymentExternalId };
  }

  function preapprovalNotification(status: string, subscriptionExternalId: string, notificationId = nextNotificationId()): ParsedWebhook {
    fakeProvider.setSubscriptionStatus(subscriptionExternalId, status);
    return { notificationId, rawEvent: 'subscription_preapproval', resourceKind: 'preapproval', resourceId: subscriptionExternalId };
  }

  /** Every processed webhook writes a `payment_webhook_events` row for dedupe bookkeeping (`markEvent`) — tests call this directly since `process()` itself doesn't insert that row (the CONTROLLER does, before enqueuing; see the controller's own describe block below). Inserted here to let `process()`'s own idempotency-relevant behavior (re-marking `processed`/`failed`) be observed. */
  async function seedWebhookEventRow(notificationId: string): Promise<void> {
    await prisma.paymentWebhookEvent.create({ data: { id: notificationId, provider: 'mercadopago', type: 'test', raw: {} } });
  }

  async function createOrder(payerEmail?: string): Promise<{ orderId: string; subscriptionId: string; amountCents: number; paymentExternalId: string; externalReference: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, paymentMethod: 'pix', payerEmail },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // A pix checkout created this charge at (the fake) Mercado Pago
    // already — it belongs to no preapproval, and `externalReference` is
    // the only thing linking it back to the order.
    const paymentExternalId = `fake-pay-${body.externalReference}`;
    return {
      orderId: body.id,
      subscriptionId: body.subscriptionId,
      amountCents: body.amountCents,
      paymentExternalId,
      externalReference: body.externalReference as string,
    };
  }

  /**
   * A CARD checkout, which is the only flow where Mercado Pago itself
   * generates charges on a schedule (a preapproval). Pix has no such
   * thing — its renewals are created by this platform's own billing
   * job, each with its own order and `external_reference`.
   */
  async function createCardOrder(): Promise<{ orderId: string; subscriptionId: string; amountCents: number; preapprovalId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, paymentMethod: 'card' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    return {
      orderId: body.id,
      subscriptionId: body.subscriptionId,
      amountCents: body.amountCents,
      preapprovalId: `fake-preapproval-${body.externalReference}`,
    };
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
    const customer = await prisma.user.create({
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
    customerId = customer.id;
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
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved', paidAmountCents: amountCents, approvedAt: new Date() }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('approved', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
    expect(order?.paidAmountCents).toBe(amountCents);

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');
    expect(subscription?.autoRenew).toBe(true);
    expect(subscription?.currentPeriodEndsAt).not.toBeNull();

    const payment = await prisma.payment.findUnique({ where: { id: paymentExternalId } });
    expect(payment?.status).toBe('approved');
    expect(payment?.orderId).toBe(orderId);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed');
  });

  it('accepts a Pix paid by a different Mercado Pago e-mail while keeping the GXHost order owner', async () => {
    const payerEmail = `pix-third-party-${suffix}@outlook.com`;
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder(payerEmail);
    expect((fakeProvider.payments.get(paymentExternalId)?.raw as { payerEmail?: string }).payerEmail).toBe(payerEmail);
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('approved', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    expect(order.status).toBe('paid');
    expect(order.userId).toBe(customerId);
    const subscription = await asAdmin((tx) => tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }));
    expect(subscription.userId).toBe(customerId);
    expect(subscription.status).toBe('active');
  });

  it('redelivering the exact same notification is an idempotent no-op', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    const parsed = paymentNotification('approved', paymentExternalId, notificationId);
    await webhookService.process(parsed);
    await webhookService.process(parsed); // exact same notification — a retried BullMQ job, or a redelivery

    const events = await asAdmin((tx) => tx.subscriptionEvent.findMany({ where: { subscriptionId } }));
    expect(events.filter((e: any) => e.toStatus === 'active')).toHaveLength(1);

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
  });

  it('a SECOND, different notification about an already-paid order is also a no-op (order-status guard, not just notification-id dedup)', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved' }));

    const first = nextNotificationId();
    await seedWebhookEventRow(first);
    await webhookService.process(paymentNotification('approved', paymentExternalId, first));

    // A DIFFERENT notification id about the SAME underlying payment —
    // Mercado Pago's own at-least-once delivery can produce this (e.g.
    // PAYMENT_CREATED then PAYMENT_CONFIRMED for one payment id).
    const second = nextNotificationId();
    await seedWebhookEventRow(second);
    await webhookService.process(paymentNotification('approved', paymentExternalId, second));

    const events = await asAdmin((tx) => tx.subscriptionEvent.findMany({ where: { subscriptionId } }));
    expect(events.filter((e: any) => e.toStatus === 'active')).toHaveLength(1);
    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
  });

  it('a payment whose subscription this platform has no record of is acknowledged with no effect', async () => {
    const paymentExternalId = `fake-pay-orphan-${suffix}`;
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference: 'ref-does-not-exist', amountCents: 1000, status: 'approved' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('approved', paymentExternalId, notificationId));

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed'); // acknowledged (an audit entry is recorded), never retried forever
  });

  it('an "Ignored" internal event is a pure no-op', async () => {
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    // A topic this platform doesn't subscribe to (`resourceKind: null`)
    // — acknowledged and recorded, nothing acted on.
    await webhookService.process({ notificationId, rawEvent: 'subscription_preapproval_plan', resourceKind: null, resourceId: null });
    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed');
  });

  it('an amount mismatch never activates the order', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents: amountCents - 100, status: 'approved' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('approved', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('pending');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('pending');
  });

  it('a payment stuck PENDING never activates the order; the later CONFIRMED notification does', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    // PENDING isn't in the payment-shaped event set at all — no
    // A charge sitting in `pending` (or `in_process`) is not an outcome
    // — Mercado Pago notifies on creation too, and that must never
    // activate anything.
    const holdNotification = nextNotificationId();
    await seedWebhookEventRow(holdNotification);
    await webhookService.process(paymentNotification('pending', paymentExternalId, holdNotification));
    let order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('pending');

    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved' }));
    const confirmNotification = nextNotificationId();
    await seedWebhookEventRow(confirmNotification);
    await webhookService.process(paymentNotification('approved', paymentExternalId, confirmNotification));

    order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('paid');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');
  });

  it('a failed payment marks the order failed but leaves the subscription pending', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'rejected' }));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('rejected', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('failed');
    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('pending'); // never active — a failed payment must never activate anything
  });

  it('a rejected RENEWAL charge moves the subscription to past_due WITHOUT suspending it — billing-cycle owns suspension, not the webhook', async () => {
    const { subscriptionId, amountCents, preapprovalId } = await createCardOrder();
    const firstCharge = fakeProvider.addRecurringCharge(preapprovalId, `fake-pay-card-first-${suffix}`, 'approved', amountCents);
    await webhookService.process(recurringChargeNotification(firstCharge.id, nextNotificationId()));

    // A payment never reverts approved -> rejected. What actually goes
    // delinquent is a DIFFERENT, later charge for the NEXT cycle, which
    // Mercado Pago generated on its own from the preapproval — and
    // because it is a RENEWAL, a rejection means past_due rather than a
    // merely failed order.
    const renewalPaymentId = `fake-pay-renewal-overdue-${suffix}`;
    fakeProvider.addRecurringCharge(preapprovalId, renewalPaymentId, 'rejected', amountCents);
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(recurringChargeNotification(renewalPaymentId, notificationId));

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('past_due');
  });

  it('a refunded payment on an already-paid order suspends the active subscription', async () => {
    const { orderId, subscriptionId, amountCents, paymentExternalId, externalReference } = await createOrder();
    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'approved' }));
    await webhookService.process(paymentNotification('approved', paymentExternalId, nextNotificationId()));
    let subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('active');

    fakeProvider.payments.set(paymentExternalId, fakePayment({ id: paymentExternalId, externalReference, amountCents, status: 'refunded' }));
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(paymentNotification('refunded', paymentExternalId, notificationId));

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('refunded');
    subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('suspended');
  });

  it("a recurring charge Mercado Pago generates on its own creates a NEW plan_renewal order and extends the subscription's period", async () => {
    const { subscriptionId, amountCents, preapprovalId } = await createCardOrder();
    const firstCharge = fakeProvider.addRecurringCharge(preapprovalId, `fake-pay-card-initial-${suffix}`, 'approved', amountCents);
    await webhookService.process(recurringChargeNotification(firstCharge.id, nextNotificationId()));

    const beforeRenewal: any = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(beforeRenewal.status).toBe('active');

    // A brand new payment id — Mercado Pago's preapproval scheduler
    // generated this on its own, referencing only the preapproval and no
    // `Order` at all.
    const renewalPaymentId = `fake-pay-renewal-${suffix}`;
    fakeProvider.addRecurringCharge(preapprovalId, renewalPaymentId, 'approved', amountCents);
    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(recurringChargeNotification(renewalPaymentId, notificationId));

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

  it('a preapproval cancelled at Mercado Pago cancels the subscription', async () => {
    const { subscriptionId, amountCents, preapprovalId } = await createCardOrder();
    const charge = fakeProvider.addRecurringCharge(preapprovalId, `fake-pay-card-cancel-${suffix}`, 'approved', amountCents);
    await webhookService.process(recurringChargeNotification(charge.id, nextNotificationId()));

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(preapprovalNotification('cancelled', preapprovalId, notificationId));

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('cancelled');
  });

  it('an AUTHORIZED preapproval is not a payment — it never marks the order paid, activates the subscription, or provisions anything', async () => {
    const { orderId, subscriptionId, preapprovalId } = await createCardOrder();

    const notificationId = nextNotificationId();
    await seedWebhookEventRow(notificationId);
    await webhookService.process(preapprovalNotification('authorized', preapprovalId, notificationId));

    // The customer authorized FUTURE charges. No money has moved.
    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order?.status).toBe('pending');
    expect(order?.paidAt).toBeNull();
    expect(order?.provisioningStatus).toBe('pending'); // still waiting — never provisioned off an authorization

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription?.status).toBe('pending');

    const payments = await asAdmin((tx) => tx.payment.findMany({ where: { orderId } }));
    expect(payments).toHaveLength(0);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event?.status).toBe('processed'); // acknowledged, just not acted on as a payment
  });

  it('the SAME recurring charge delivered twice extends the period only once', async () => {
    const { subscriptionId, amountCents, preapprovalId } = await createCardOrder();
    const first = fakeProvider.addRecurringCharge(preapprovalId, `fake-pay-dedupe-first-${suffix}`, 'approved', amountCents);
    await webhookService.process(recurringChargeNotification(first.id, nextNotificationId()));

    const renewalId = `fake-pay-dedupe-renewal-${suffix}`;
    fakeProvider.addRecurringCharge(preapprovalId, renewalId, 'approved', amountCents);

    const firstDelivery = nextNotificationId();
    await seedWebhookEventRow(firstDelivery);
    await webhookService.process(recurringChargeNotification(renewalId, firstDelivery));
    const afterFirst: any = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));

    // Mercado Pago redelivers the same charge under a new notification
    // id — the PAYMENT id is what makes this idempotent, not the
    // notification id.
    const secondDelivery = nextNotificationId();
    await seedWebhookEventRow(secondDelivery);
    await webhookService.process(recurringChargeNotification(renewalId, secondDelivery));

    const afterSecond: any = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(new Date(afterSecond.currentPeriodEndsAt).getTime()).toBe(new Date(afterFirst.currentPeriodEndsAt).getTime());

    const renewalOrders = await asAdmin((tx) => tx.order.findMany({ where: { subscriptionId, kind: 'plan_renewal' } }));
    expect(renewalOrders).toHaveLength(1);
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
      url: '/api/webhooks/mercadopago',
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
    const res = await webhookPost({ id: notificationId, type: 'payment', action: 'payment.updated', data: { id: 'pay-x' } }, 'wrong-token');
    expect(res.statusCode).toBe(401);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event).toBeNull();
  });

  it('a valid webhook is recorded and enqueued, responding 200 without processing it synchronously', async () => {
    const notificationId = `evt-valid-${suffix}`;
    const res = await webhookPost({ id: notificationId, type: 'payment', action: 'payment.updated', data: { id: 'pay-x' } });
    expect(res.statusCode).toBe(200);

    const event = await prisma.paymentWebhookEvent.findUnique({ where: { id: notificationId } });
    expect(event).not.toBeNull();
    expect(event?.provider).toBe('mercadopago');
    expect(event?.status).toBe('received'); // never 'processed' here — no worker is running in this test process
  });

  it('a redelivered notification (same id) is still 200, without a second event row', async () => {
    const notificationId = `evt-redeliver-${suffix}`;
    const first = await webhookPost({ id: notificationId, type: 'payment', action: 'payment.updated', data: { id: 'pay-y' } });
    expect(first.statusCode).toBe(200);
    const second = await webhookPost({ id: notificationId, type: 'payment', action: 'payment.updated', data: { id: 'pay-y' } });
    expect(second.statusCode).toBe(200);

    const count = await prisma.paymentWebhookEvent.count({ where: { id: notificationId } });
    expect(count).toBe(1);
  });
});
