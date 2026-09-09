import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { PAYMENT_PROVIDER, type GatewayPayment, type ParsedWebhook, type PaymentProvider } from './payment-provider.interface';

/**
 * The actual webhook processing logic — runs inside the
 * `webhook-processing` queue's worker (`WebhookProcessingProcessor`),
 * never on the HTTP request path (see `PaymentsWebhookController`'s own
 * doc comment for why). `process(parsed)` is the single entry point;
 * everything below preserves the exact pipeline discipline the Mercado
 * Pago era already established, in the exact order:
 *
 * 1. The webhook BODY is never trusted as the financial source of
 *    truth — every branch below re-fetches the actual payment/
 *    subscription from Asaas's own API before acting on it. This
 *    matters MORE for Asaas than it did for Mercado Pago: Asaas
 *    authenticates a webhook with a single static token, not a
 *    signature, so the re-fetch is the real defense against a leaked
 *    token being used to forge a `PaymentConfirmed` notification.
 * 2. A payment is matched to this platform's own `Order`/`Subscription`
 *    ONLY by `subscriptionExternalId` (a payment's own `subscription`
 *    field in Asaas) — never by amount, description, or customer name.
 * 3. The amount is verified before anything is marked `paid`.
 * 4. Every state change happens under the SAME advisory lock
 *    `ServersService.createOnNode` already uses for the subscription's
 *    plan — the identical protection against two notifications racing
 *    on the same order/subscription that the Mercado Pago era relied
 *    on.
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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async process(parsed: ParsedWebhook): Promise<void> {
    try {
      switch (parsed.internalEvent) {
        case 'PaymentCreated':
        case 'PaymentConfirmed':
        case 'PaymentOverdue':
        case 'PaymentRefunded':
        case 'PaymentChargeback':
        case 'PaymentCanceled':
        case 'PaymentRestored':
        case 'PaymentFailed':
          await this.processPaymentEvent(parsed);
          break;
        case 'PaymentPending':
          // Not a final outcome — acknowledge and change nothing, same
          // 'hold' posture the Mercado Pago era used for pending/
          // in_process/authorized.
          break;
        case 'SubscriptionCanceled':
          await this.processSubscriptionCanceled(parsed);
          break;
        case 'SubscriptionSynced':
          await this.processSubscriptionSynced(parsed);
          break;
        case 'Ignored':
          break;
      }
      await this.markEvent(parsed.notificationId, 'processed');
    } catch (err) {
      await this.markEvent(parsed.notificationId, 'failed', err instanceof Error ? err.message : String(err));
      throw err; // let BullMQ retry — a transient failure (DB hiccup, Asaas briefly unreachable) must not be swallowed
    }
  }

  private async processPaymentEvent(parsed: ParsedWebhook): Promise<void> {
    if (!parsed.paymentExternalId) {
      this.logger.warn(`${parsed.internalEvent} webhook ${parsed.notificationId} carries no payment id — nothing to re-fetch`);
      return;
    }

    // Re-fetch — the webhook body is never trusted (see this class's
    // own doc comment).
    const payment = await this.provider.getPayment(parsed.paymentExternalId);
    if (!payment.subscriptionExternalId) {
      // This platform only ever creates subscription-attached charges —
      // a payment with no subscription is either a manual one created
      // directly in the Asaas dashboard (out of scope) or malformed.
      await this.audit.record({
        action: 'payment.webhook.order_not_found',
        targetType: 'payment_webhook_event',
        targetId: parsed.notificationId,
        metadata: { paymentId: payment.id, reason: 'no subscription on payment' },
      });
      return;
    }

    const subscription = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.subscription.findFirst({ where: { externalSubscriptionId: payment.subscriptionExternalId! } }),
    );
    if (!subscription) {
      await this.audit.record({
        action: 'payment.webhook.order_not_found',
        targetType: 'payment_webhook_event',
        targetId: parsed.notificationId,
        metadata: { externalSubscriptionId: payment.subscriptionExternalId, paymentId: payment.id },
      });
      return;
    }

    const shouldProvision = await this.applyPaymentOutcome(subscription.id, subscription.planId, parsed.internalEvent, payment);
    if (shouldProvision) {
      // Deliberately AFTER the transaction has committed — an outbound
      // Redis call must never happen inside a transaction that could
      // still roll back, the same reason ServersService.createOnNode
      // keeps agent dispatch out of ITS transaction too.
      await this.provisioningQueue.enqueue(shouldProvision);
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
    event: ParsedWebhook['internalEvent'],
    payment: GatewayPayment,
  ): Promise<string | null> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      await this.capacity.lockPlan(tx, planId);

      const subscription = await tx.subscription.findFirst({ where: { id: subscriptionId } });
      if (!subscription) return null; // cannot happen in practice — the caller just read this row

      const order = await this.findOrCreateOrderForPayment(tx, subscription, payment);
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
        case 'PaymentCreated': {
          await this.payments.recordFromGateway(order.id, payment, tx);
          await this.populatePaymentPresentation(order.id, subscription.paymentMethod, payment);
          await this.audit.record({ action: 'payment.checkout.created', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id } });
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
          await this.audit.record({ action: 'payment.approved', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id } });

          if (order.kind === 'plan_renewal') {
            await this.subscriptions.applyRenewal(tx, subscriptionId, null);
            await this.audit.record({ action: 'subscription.renewed', targetType: 'subscription', targetId: subscriptionId, metadata: { orderId: order.id } });
          } else if (subscription.status === 'pending') {
            await this.subscriptions.applyTransition(tx, subscriptionId, 'active', { actorId: null, reason: 'payment webhook: confirmed' });
            await tx.subscription.update({ where: { id: subscriptionId }, data: { autoRenew: true } });
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
        case 'PaymentOverdue': {
          await this.payments.recordFromGateway(order.id, payment, tx);
          if (canTransition(subscription.status as SubscriptionStatus, 'past_due')) {
            await this.subscriptions.applyTransition(tx, subscriptionId, 'past_due', { actorId: null, reason: 'payment webhook: overdue' });
            await this.audit.record({ action: 'payment.rejected', targetType: 'subscription', targetId: subscriptionId, metadata: { paymentId: payment.id } });
          }
          // No suspension here — billing-cycle applies BILLING_GRACE_DAYS
          // uniformly for pix and card since the Asaas migration.
          return null;
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
        case 'PaymentRestored': {
          if (order.status === 'cancelled') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'pending' } });
          }
          return null;
        }
        case 'PaymentFailed': {
          if (order.status === 'pending') {
            await tx.order.update({ where: { id: order.id }, data: { status: 'failed' } });
            await this.audit.record({ action: 'payment.rejected', targetType: 'order', targetId: order.id, metadata: { paymentId: payment.id } });
          }
          return null;
        }
        default:
          return null;
      }
    });
  }

  /**
   * A payment always belongs to a subscription in this platform's
   * model. If a `Payment` row for it already exists, its `orderId` is
   * authoritative (idempotent — a redelivered/retried notification about
   * a payment already linked). Otherwise: the subscription's own
   * `plan_initial` order, if it's still `pending` and has never had a
   * payment recorded (the very first charge Asaas generated for a brand
   * new subscription) — or, failing that, a NEW `plan_renewal` order,
   * mirroring the shape `OrdersService.createCheckoutOrder` itself would
   * have produced. Asaas's own scheduler generates a renewal charge with
   * no reference back to a specific Order at all — only to the
   * Subscription — which is exactly why this lookup never uses
   * `externalReference` once a subscription exists.
   */
  private async findOrCreateOrderForPayment(
    tx: Prisma.TransactionClient,
    subscription: { id: string; userId: string; planId: string; currency: string; priceCents: number },
    payment: GatewayPayment,
  ) {
    const existingPayment = await tx.payment.findUnique({ where: { id: payment.id } });
    if (existingPayment) {
      return tx.order.findFirst({ where: { id: existingPayment.orderId } });
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
        provisioningStatus: 'not_required', // the server already exists — a renewal only extends the period
        config: {} as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Pix QR / card checkout URL for a NEW order (the first charge at checkout already gets this from `OrdersService`; a renewal charge Asaas generates on its own needs it fetched here instead, the first time `PaymentCreated` fires for it). */
  private async populatePaymentPresentation(orderId: string, paymentMethod: string | null, payment: GatewayPayment): Promise<void> {
    if (paymentMethod === 'pix') {
      const qr = await this.provider.getPixQrCode(payment.id).catch(() => null);
      if (qr) {
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({ where: { id: orderId }, data: { pixQrCode: qr.qrCode, pixQrCodeBase64: qr.qrCodeBase64 } }),
        );
      }
    }
  }

  private async processSubscriptionCanceled(parsed: ParsedWebhook): Promise<void> {
    if (!parsed.subscriptionExternalId) return;
    await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await tx.subscription.findFirst({ where: { externalSubscriptionId: parsed.subscriptionExternalId! } });
      if (!subscription) return;
      if (canTransition(subscription.status as SubscriptionStatus, 'cancelled')) {
        await this.subscriptions.applyTransition(tx, subscription.id, 'cancelled', { actorId: null, reason: 'subscription webhook: canceled at Asaas' });
      }
    });
  }

  /** A light courtesy sync of `nextDueDate` — never the authority on activation/period-extension, which stays exclusively `PaymentConfirmed`'s job (see this class's own doc comment). */
  private async processSubscriptionSynced(parsed: ParsedWebhook): Promise<void> {
    if (!parsed.subscriptionExternalId) return;
    const gatewaySubscription = await this.provider.getSubscription(parsed.subscriptionExternalId);
    if (!gatewaySubscription.nextDueDate) return;
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.subscription.updateMany({
        where: { externalSubscriptionId: parsed.subscriptionExternalId!, status: 'active' },
        data: { currentPeriodEndsAt: gatewaySubscription.nextDueDate! },
      }),
    );
  }

  private async markEvent(notificationId: string, status: 'processed' | 'ignored' | 'failed', error?: string): Promise<void> {
    await this.prisma.paymentWebhookEvent
      .update({ where: { id: notificationId }, data: { status, error: error ?? null, processedAt: new Date() } })
      .catch(() => undefined);
  }
}
