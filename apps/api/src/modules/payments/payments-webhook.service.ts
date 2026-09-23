import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CapacityService } from '../capacity/capacity.service';
import { AuditService } from '../audit/audit.service';
import { ServersService } from '../servers/servers.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { canTransition, type SubscriptionStatus } from '../subscriptions/subscription-status';
import { PaymentsService } from './payments.service';
import { ProvisioningQueueService } from './provisioning-queue.service';
import {
  type GatewayPayment,
  type GatewaySubscription,
  type InternalPaymentEvent,
  type ParsedWebhook,
  type PaymentProvider,
} from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';

/**
 * The actual webhook processing logic — runs inside the
 * `webhook-processing` queue's worker (`WebhookProcessingProcessor`),
 * never on the HTTP request path (see `PaymentsWebhookController`'s own
 * doc comment for why). `process(parsed)` is the single entry point,
 * and the pipeline discipline below is in this exact order:
 *
 * 1. The webhook BODY is never trusted as the financial source of
 *    truth. It cannot be, even in principle: Mercado Pago's
 *    notification carries nothing but a resource id and
 *    `payment.created`/`payment.updated` — the outcome lives in the
 *    resource itself. So every branch re-fetches from Mercado Pago's
 *    API and runs the result through `provider.classifyPayment` /
 *    `classifySubscription`.
 * 2. A payment is matched to this platform's own `Order`/`Subscription`
 *    ONLY by an identifier this platform itself generated
 *    (`external_reference`, for a standalone Pix charge) or by the
 *    preapproval id it belongs to (for a recurring card charge) — never
 *    by amount, description, or payer name.
 * 3. The amount is verified before anything is marked `paid`.
 * 4. Every state change happens under the SAME advisory lock
 *    `ServersService.createOnNode` already uses for the subscription's
 *    plan — protection against two notifications racing on the same
 *    order/subscription.
 *
 * A preapproval turning `authorized` is deliberately NOT a payment: the
 * customer authorized future charges, they have not paid. Only a
 * re-fetched payment whose own status is `approved` ever produces
 * `PaymentConfirmed`.
 *
 * `process` is safe to call twice for the same notification (BullMQ's
 * own retry, or a redelivered webhook whose dedupe-insert already
 * succeeded before a prior worker crashed mid-job) — every branch below
 * re-checks the CURRENT state before acting, never assumes it's the
 * first time.
 */
@Injectable()
export class PaymentsWebhookService {
  private readonly logger = new Logger(PaymentsWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityService,
    private readonly audit: AuditService,
    private readonly servers: ServersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: PaymentsService,
    private readonly provisioningQueue: ProvisioningQueueService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  async process(parsed: ParsedWebhook, providerName = 'mercadopago'): Promise<void> {
    const provider = this.providers.get(providerName);
    try {
      switch (parsed.resourceKind) {
        case 'payment':
        case 'authorized_payment':
          await this.processPaymentEvent(parsed, provider);
          break;
        case 'preapproval':
          await this.processPreapprovalEvent(parsed, provider);
          break;
        case null:
          // A topic this platform doesn't handle. Acknowledged, recorded,
          // and deliberately no-op — never an error, or Mercado Pago
          // would retry it forever.
          break;
      }
      await this.markEvent(parsed.notificationId, 'processed');
    } catch (err) {
      await this.markEvent(parsed.notificationId, 'failed', err instanceof Error ? err.message : String(err));
      throw err; // let BullMQ retry — a transient failure (DB hiccup, Mercado Pago briefly unreachable) must not be swallowed
    }
  }

  /**
   * A `payment` or `subscription_authorized_payment` notification. The
   * outcome comes from the re-fetched resource's own status, never from
   * the notification (see this class's doc comment).
   */
  private async processPaymentEvent(parsed: ParsedWebhook, provider: PaymentProvider): Promise<void> {
    if (!parsed.resourceId) {
      this.logger.warn(`${parsed.rawEvent} webhook ${parsed.notificationId} carries no resource id — nothing to re-fetch`);
      return;
    }

    const payment =
      parsed.resourceKind === 'authorized_payment'
        ? await provider.getAuthorizedPayment(parsed.resourceId)
        : await provider.getPayment(parsed.resourceId);

    const event = provider.classifyPayment(payment);
    if (event === 'Ignored') return;

    const subscription = await this.findSubscriptionForPayment(payment, provider.name);
    if (!subscription) {
      await this.audit.record({
        action: 'payment.webhook.order_not_found',
        targetType: 'payment_webhook_event',
        targetId: parsed.notificationId,
        metadata: {
          paymentId: payment.id,
          externalReference: payment.externalReference,
          externalSubscriptionId: payment.subscriptionExternalId,
        },
      });
      return;
    }

    const shouldProvision = await this.applyPaymentOutcome(subscription.id, subscription.planId, event, payment, provider.name);
    if (shouldProvision) {
      // Deliberately AFTER the transaction has committed — an outbound
      // Redis call must never happen inside a transaction that could
      // still roll back, the same reason ServersService.createOnNode
      // keeps agent dispatch out of ITS transaction too.
      await this.provisioningQueue.enqueue(shouldProvision);
    }
  }

  /**
   * Two ways a Mercado Pago payment links back to a subscription here,
   * and no third — never by amount or payer:
   *  - a **recurring card charge** carries the `preapproval_id` it
   *    belongs to (`Subscription.externalSubscriptionId`);
   *  - a **standalone Pix charge** belongs to no preapproval at all, so
   *    it carries the `external_reference` this platform generated for
   *    the Order it was created for.
   */
  private async findSubscriptionForPayment(payment: GatewayPayment, providerName: string) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      if (payment.subscriptionExternalId) {
        return tx.subscription.findFirst({ where: { externalSubscriptionId: payment.subscriptionExternalId, paymentProvider: providerName } });
      }
      if (payment.externalReference) {
        const order = await tx.order.findFirst({ where: { externalReference: payment.externalReference, provider: providerName } });
        if (order?.subscriptionId) {
          return tx.subscription.findFirst({ where: { id: order.subscriptionId } });
        }
      }
      return null;
    });
  }

  /**
   * A `subscription_preapproval` notification — the customer authorized
   * (or cancelled/paused) the recurring card charge. Authorization is
   * NOT payment: it never marks an order paid, never activates a
   * subscription, and never provisions a server. Only the charge that
   * follows does.
   */
  private async processPreapprovalEvent(parsed: ParsedWebhook, provider: PaymentProvider): Promise<void> {
    if (!parsed.resourceId) return;
    const subscription = await provider.getSubscription(parsed.resourceId);
    const event = provider.classifySubscription(subscription);

    if (event === 'SubscriptionCanceled') {
      await this.processSubscriptionCanceled(parsed.resourceId, subscription, provider.name);
      return;
    }
    if (event === 'SubscriptionPastDue') {
      await this.processSubscriptionPastDue(parsed.resourceId, subscription, provider.name);
      return;
    }
    if (event === 'SubscriptionSynced') {
      await this.processSubscriptionSynced(parsed.resourceId, subscription, provider.name);
    }
  }

  /**
   * Finds (or creates) the `Order` this payment belongs to, then
   * applies the outcome — all under the subscription's plan lock, same
   * `capacity.lockPlan` two racing notifications on one order already
   * serialize on. Returns the order id to provision, or `null`.
   */
  private async applyPaymentOutcome(
    subscriptionId: string,
    planId: string,
    event: InternalPaymentEvent,
    payment: GatewayPayment,
    providerName: string,
  ): Promise<string | null> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      await this.capacity.lockPlan(tx, planId);

      const subscription = await tx.subscription.findFirst({ where: { id: subscriptionId } });
      if (!subscription) return null; // cannot happen in practice — the caller just read this row

      const order = await this.findOrCreateOrderForPayment(tx, subscription, payment, providerName);
      if (!order) return null; // an existing Payment row pointed at an order that's gone — cannot happen, defensive only

      // Idempotent no-op: this exact payment status was already applied
      // (a retried job, or a redelivered notification whose dedupe-
      // insert raced a prior worker crash).
      if (order.status === 'refunded' || order.status === 'cancelled') return null;
      if (order.status === 'paid' && event !== 'PaymentRefunded' && event !== 'PaymentChargeback') {
        await this.payments.recordFromGateway(order.id, payment, tx);
        return null;
      }

      switch (event) {
        case 'PaymentPending': {
          // Not a final outcome — record the charge so the admin can see
          // it, and change nothing else. (Nothing needs fetching for
          // presentation: every Pix QR this platform shows was captured
          // when the charge was CREATED, by checkout or by the billing
          // cycle — Mercado Pago never generates a charge on its own for
          // pix, and a card charge has no QR.)
          await this.payments.recordFromGateway(order.id, payment, tx);
          return null;
        }
        case 'PaymentConfirmed': {
          if (payment.amountCents !== order.amountCents) {
            await this.audit.record({
              action: 'payment.amount_mismatch',
              targetType: 'order',
              targetId: order.id,
              metadata: { expectedCents: order.amountCents, receivedCents: payment.amountCents, paymentId: payment.id },
            });
            return null;
          }
          await this.payments.recordFromGateway(order.id, payment, tx);
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'paid',
              paidAt: payment.approvedAt ?? new Date(),
              paymentMethod: subscription.paymentMethod,
              paidAmountCents: payment.paidAmountCents ?? payment.amountCents,
            },
          });
          this.logger.log(`${providerName} payment approved providerPaymentId=${payment.id} orderId=${order.id} userId=${order.userId}`);
          await this.audit.record({ action: 'payment.approved', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id } });

          if (order.kind === 'plan_renewal') {
            await this.subscriptions.applyRenewal(tx, subscriptionId, null);
            await this.audit.record({ action: 'subscription.renewed', targetType: 'subscription', targetId: subscriptionId, metadata: { orderId: order.id } });
          } else if (subscription.status === 'pending') {
            await this.subscriptions.applyTransition(tx, subscriptionId, 'active', { actorId: null, reason: 'payment webhook: confirmed' });
            await tx.subscription.update({ where: { id: subscriptionId }, data: { autoRenew: subscription.paymentMethod === 'card' } });
            await this.audit.record({ action: 'subscription.activated', targetType: 'subscription', targetId: subscriptionId, metadata: { orderId: order.id } });
          } else if (subscription.status === 'past_due' || subscription.status === 'suspended') {
            // Recovery — a formerly-suspended/overdue subscription pays
            // again. Only reactivates a SERVER this platform's own
            // billing suspended (never an admin's abuse suspension) —
            // see ServersService.unsuspend's `requireSource` guard.
            const wasSuspended = subscription.status === 'suspended';
            await this.subscriptions.applyTransition(tx, subscriptionId, 'active', { actorId: null, reason: 'payment webhook: confirmed (recovered)' });
            await this.audit.record({ action: 'subscription.reactivated.billing', targetType: 'subscription', targetId: subscriptionId, metadata: { orderId: order.id } });
            if (wasSuspended && subscription.serverId) {
              const reactivated = await this.servers.unsuspend(subscription.serverId, null, { requireSource: 'billing' });
              if (reactivated) {
                await this.audit.record({ action: 'server.reactivated.billing', targetType: 'server', targetId: subscription.serverId });
              }
            }
          }

          // Only a `plan_initial` order (provisioningStatus seeded
          // 'pending' by OrdersService.createCheckoutOrder) ever needs a
          // server — a renewal's provisioningStatus is 'not_required'.
          return order.provisioningStatus === 'pending' ? order.id : null;
        }
        case 'PaymentRefunded':
        case 'PaymentChargeback': {
          await this.payments.recordFromGateway(order.id, payment, tx);
          await tx.order.update({ where: { id: order.id }, data: { status: 'refunded' } });
          if (canTransition(subscription.status as SubscriptionStatus, 'suspended')) {
            await this.subscriptions.applyTransition(tx, subscriptionId, 'suspended', { actorId: null, reason: `payment webhook: ${event}` });
          }
          await this.audit.record({ action: 'payment.refunded', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id, event } });
          return null;
        }
        case 'PaymentCanceled': {
          if (order.status === 'pending') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
          }
          return null;
        }
        case 'PaymentFailed': {
          await this.payments.recordFromGateway(order.id, payment, tx);
          if (order.status === 'pending') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'failed' } });
          }
          await this.audit.record({ action: 'payment.rejected', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id } });

          // A RENEWAL charge Mercado Pago rejected is delinquency: the
          // customer has a running subscription and this period's money
          // did not arrive, so the grace period starts now (billing-cycle
          // suspends after BILLING_GRACE_DAYS). A FIRST charge failing is
          // not delinquency at all — nothing was ever activated, so the
          // order simply fails and the subscription stays `pending`.
          if (order.kind === 'plan_renewal' && canTransition(subscription.status as SubscriptionStatus, 'past_due')) {
            await this.subscriptions.applyTransition(tx, subscriptionId, 'past_due', { actorId: null, reason: 'payment webhook: renewal charge rejected' });
          }
          return null;
        }
        default:
          return null;
      }
    });
  }

  /**
   * Resolves the `Order` a payment belongs to, in strict order of how
   * certain the link is:
   *
   * 1. A `Payment` row already exists for this provider payment id — its
   *    `orderId` is authoritative (idempotent: a redelivered or retried
   *    notification about a charge already linked).
   * 2. The payment echoes an `external_reference` — this platform
   *    generated that charge FOR a specific order (every pix charge,
   *    whether from checkout or from the billing cycle), so that order
   *    is an exact match.
   * 3. Otherwise this is a recurring card charge Mercado Pago generated
   *    on its own schedule, which references only the preapproval and no
   *    order at all: reuse the subscription's untouched `plan_initial`
   *    order if it's still awaiting its first payment, else create a NEW
   *    `plan_renewal` order mirroring the shape
   *    `OrdersService.createCheckoutOrder` itself would have produced.
   */
  private async findOrCreateOrderForPayment(
    tx: Prisma.TransactionClient,
    subscription: { id: string; userId: string; planId: string; currency: string; priceCents: number },
    payment: GatewayPayment,
    providerName: string,
  ) {
    const existingPayment = await tx.payment.findUnique({ where: { id: payment.id } });
    if (existingPayment) {
      return tx.order.findFirst({ where: { id: existingPayment.orderId } });
    }

    if (payment.externalReference) {
      const referenced = await tx.order.findFirst({ where: { externalReference: payment.externalReference } });
      if (referenced) return referenced;
    }

    const initialOrder = await tx.order.findFirst({
      where: { subscriptionId: subscription.id, kind: 'plan_initial', status: 'pending' },
      include: { payments: { select: { id: true }, take: 1 } },
    });
    if (initialOrder && initialOrder.payments.length === 0) {
      return initialOrder;
    }

    return tx.order.create({
      data: {
        externalReference: `ord_${randomBytes(24).toString('base64url')}`,
        userId: subscription.userId,
        planId: subscription.planId,
        subscriptionId: subscription.id,
        kind: 'plan_renewal',
        amountCents: payment.amountCents ?? subscription.priceCents,
        currency: subscription.currency,
        status: 'pending',
        provider: providerName,
        provisioningStatus: 'not_required', // the server already exists — a renewal only extends the period
        config: {} as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async processSubscriptionCanceled(externalSubscriptionId: string, gateway: GatewaySubscription, providerName: string): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await this.findSubscriptionForGateway(tx, externalSubscriptionId, gateway, providerName);
      if (!subscription) return;
      if (canTransition(subscription.status as SubscriptionStatus, 'cancelled')) {
        await this.subscriptions.applyTransition(tx, subscription.id, 'cancelled', {
          actorId: null,
          reason: `subscription webhook: cancelled at ${providerName}`,
        });
      }
    });
  }

  /**
   * A light courtesy sync of the next charge date — never the authority
   * on activation or period extension, which stays exclusively
   * `PaymentConfirmed`'s job (see this class's own doc comment). This is
   * the ONLY thing an `authorized` preapproval does on this platform.
   */
  private async processSubscriptionSynced(externalSubscriptionId: string, gatewaySubscription: GatewaySubscription, providerName: string): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await this.findSubscriptionForGateway(tx, externalSubscriptionId, gatewaySubscription, providerName);
      if (!subscription || !gatewaySubscription.nextDueDate || subscription.status !== 'active') return;
      await tx.subscription.update({ where: { id: subscription.id }, data: { currentPeriodEndsAt: gatewaySubscription.nextDueDate } });
    });
  }

  private async processSubscriptionPastDue(externalSubscriptionId: string, gateway: GatewaySubscription, providerName: string): Promise<void> {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await this.findSubscriptionForGateway(tx, externalSubscriptionId, gateway, providerName);
      if (!subscription || !canTransition(subscription.status as SubscriptionStatus, 'past_due')) return;
      await this.subscriptions.applyTransition(tx, subscription.id, 'past_due', { actorId: null, reason: `subscription webhook: overdue at ${providerName}` });
    });
  }

  private async findSubscriptionForGateway(
    tx: Prisma.TransactionClient,
    externalSubscriptionId: string,
    gateway: GatewaySubscription,
    providerName: string,
  ) {
    let subscription = await tx.subscription.findFirst({ where: { externalSubscriptionId, paymentProvider: providerName } });
    if (!subscription && gateway.externalReference) {
      const order = await tx.order.findFirst({ where: { externalReference: gateway.externalReference, provider: providerName } });
      if (order?.subscriptionId) subscription = await tx.subscription.findFirst({ where: { id: order.subscriptionId } });
    }
    if (subscription && subscription.externalSubscriptionId !== externalSubscriptionId) {
      subscription = await tx.subscription.update({ where: { id: subscription.id }, data: { externalSubscriptionId } });
    }
    return subscription;
  }

  private async markEvent(notificationId: string, status: 'processed' | 'ignored' | 'failed', error?: string): Promise<void> {
    await this.prisma.paymentWebhookEvent
      .update({ where: { id: notificationId }, data: { status, error: error ?? null, processedAt: new Date() } })
      .catch(() => undefined);
  }
}
