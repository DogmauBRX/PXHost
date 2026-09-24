import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { type SubscriptionBillingPeriod } from '../subscriptions/subscription-status';
import { PaymentProviderRequestError, type PayerInput, type PaymentMethod, type PaymentProviderName } from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentsService } from './payments.service';
import { ProvisioningQueueService } from './provisioning-queue.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import type { ListOrdersDto } from './dto/list-orders.dto';
import type { OrderConfigSnapshot } from './order-config-snapshot';

const CHECKOUT_RL_WINDOW_SECONDS = 60 * 60;
const CHECKOUT_RL_LIMIT_PER_USER = 10;
const CHECKOUT_RL_LIMIT_PER_IP = 30;

const ORDER_SELECT = {
  id: true,
  externalReference: true,
  planId: true,
  subscriptionId: true,
  serverId: true,
  kind: true,
  amountCents: true,
  currency: true,
  status: true,
  provider: true,
  checkoutUrl: true,
  pixQrCode: true,
  pixQrCodeBase64: true,
  boletoDigitableLine: true,
  boletoUrl: true,
  paymentMethod: true,
  installments: true,
  paidAmountCents: true,
  paidAt: true,
  expiresAt: true,
  provisioningStatus: true,
  provisioningError: true,
  config: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.OrderSelect;

type BillingProfile = {
  userId: string;
  email: string;
  cpf: string;
  firstName: string | null;
  lastName: string | null;
  postalCode: string;
  addressLine: string;
  addressNumber: string;
  neighborhood: string;
  city: string;
  state: string;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: PaymentsService,
    private readonly provisioningQueue: ProvisioningQueueService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  /**
   * Rate limiting has no framework in this codebase (no `@nestjs/
   * throttler`) — the same hand-rolled Redis INCR+EXPIRE scheme
   * `AuthService.checkLoginRateLimit`/`checkRegisterRateLimit` already
   * use, copied here rather than reinvented. Per-USER (not just per-IP)
   * because a checkout is always authenticated — a compromised or
   * scripted single account hammering this endpoint from many IPs is a
   * real scenario the IP bucket alone wouldn't catch.
   */
  private async checkCheckoutRateLimit(userId: string, ip: string | null | undefined): Promise<void> {
    const userKey = `checkout_rl:user:${userId}`;
    const userCount = await this.redis.client.incr(userKey);
    if (userCount === 1) await this.redis.client.expire(userKey, CHECKOUT_RL_WINDOW_SECONDS);

    let ipCount = 0;
    if (ip) {
      const ipKey = `checkout_rl:ip:${ip}`;
      ipCount = await this.redis.client.incr(ipKey);
      if (ipCount === 1) await this.redis.client.expire(ipKey, CHECKOUT_RL_WINDOW_SECONDS);
    }

    if (userCount > CHECKOUT_RL_LIMIT_PER_USER || ipCount > CHECKOUT_RL_LIMIT_PER_IP) {
      throw new HttpException('Muitas tentativas de checkout em pouco tempo — aguarde antes de tentar novamente.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * `Order.externalReference` — sent to Mercado Pago as the charge's own
   * `external_reference` and echoed back on every notification about it.
   * For a Pix charge it is the ONLY key the webhook matches a payment
   * back by (a standalone Pix payment belongs to no preapproval), which
   * is exactly why it is server-generated, never accepted from the
   * client, and 192 bits — never plausibly guessable or reused.
   */
  private generateExternalReference(): string {
    return `ord_${randomBytes(24).toString('base64url')}`;
  }

  /**
   * Builds the payer sent to Mercado Pago. The billing profile provides
   * the required tax/address data, while `payerEmail` is intentionally a
   * separate checkout field: it may belong to a different person/account
   * than the GXHost user that owns the order. The `PaymentCustomer` table
   * stays unused under Mercado Pago; it only retains old provider history.
   */
  private toPayerInput(profile: BillingProfile, payerEmail = profile.email): PayerInput {
    return {
      userId: profile.userId,
      email: payerEmail,
      firstName: profile.firstName,
      lastName: profile.lastName,
      cpf: profile.cpf,
      address: {
        postalCode: profile.postalCode,
        addressLine: profile.addressLine,
        addressNumber: profile.addressNumber,
        neighborhood: profile.neighborhood,
        city: profile.city,
        state: profile.state,
      },
    };
  }

  /**
   * Where Mercado Pago sends the customer back after they authorize a
   * card subscription (`back_url`). UX ONLY — landing here proves
   * nothing about the money, and the page it lands on polls the order's
   * real status, which only a webhook can move to `paid`.
   */
  private checkoutReturnUrl(orderId: string): string {
    const base = this.config.get<string>('PUBLIC_SITE_URL') ?? this.config.get<string>('PANEL_URL') ?? '';
    return `${base.replace(/\/$/, '')}/client/orders/${orderId}`;
  }

  private async loadBillingProfile(tx: Prisma.TransactionClient, userId: string): Promise<BillingProfile> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        cpf: true,
        firstName: true,
        lastName: true,
        billingPostalCode: true,
        billingAddressLine: true,
        billingAddressNumber: true,
        billingNeighborhood: true,
        billingCity: true,
        billingState: true,
      },
    });
    // Guaranteed non-null here: `createPendingSubscription` already
    // threw BILLING_PROFILE_REQUIRED above if the billing profile
    // weren't complete.
    return {
      userId,
      email: user.email,
      cpf: user.cpf as string,
      firstName: user.firstName,
      lastName: user.lastName,
      postalCode: user.billingPostalCode as string,
      addressLine: user.billingAddressLine as string,
      addressNumber: user.billingAddressNumber as string,
      neighborhood: user.billingNeighborhood as string,
      city: user.billingCity as string,
      state: user.billingState as string,
    };
  }

  /**
   * The checkout entry point. Validates everything under lock, creates
   * a `pending` Subscription AND a `pending` Order in ONE transaction
   * (see `SubscriptionsService.createPendingSubscription`'s own doc
   * comment for why that has to be one transaction, not two), THEN —
   * once that's safely committed — starts the charge at Mercado Pago
   * (`startProviderSubscription` below, which branches by payment
   * method).
   *
   * Idempotency (payments plan §24): if this user already has a
   * `pending` Subscription with a `pending`, unexpired Order on the SAME
   * plan, THAT order is returned instead of creating a second one — a
   * double-click or a retried request never creates two subscriptions.
   */
  async createCheckoutOrder(userId: string, dto: CreateCheckoutDto, meta: { ip: string | null }) {
    await this.checkCheckoutRateLimit(userId, meta.ip);
    const providerName: PaymentProviderName = dto.provider ?? 'mercadopago';
    const provider = this.providers.get(providerName);
    if (provider.isConfigured?.() === false) {
      throw new ConflictException(`PAYMENT_PROVIDER_UNAVAILABLE: ${providerName}`);
    }
    const supportedMethods = provider.supportedPaymentMethods?.() ?? ['pix', 'boleto', 'card'];
    if (!supportedMethods.includes(dto.paymentMethod)) {
      throw new ConflictException(`PAYMENT_METHOD_UNAVAILABLE: ${dto.paymentMethod} is not available with ${providerName}`);
    }

    const created = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const plan = await this.subscriptions.lockAndValidatePlanForSubscription(tx, dto.planId);

      // `subscriptionId: { not: null }` guards against a `plan_initial`
      // order whose subscription was detached without the order's own
      // status ever moving off `pending` (in practice: only test
      // cleanup does this today — a real `Order` created by this method
      // always has `subscriptionId` set from the moment it exists) —
      // without it, such a row would be mistaken for a live, resumable
      // checkout and returned instead of starting a real new one.
      const duplicate = await tx.order.findFirst({
        where: { userId, planId: plan.id, kind: 'plan_initial', status: 'pending', subscriptionId: { not: null }, expiresAt: { gt: new Date() } },
      });
      // Reuse only when the payment method ALSO matches — a genuine
      // retry/reload of the same in-flight checkout, never a second
      // Mercado Pago call. A customer who comes back and picks the OTHER
      // method (Pix ⇄ Cartão) is not retrying, they changed their mind:
      // returning the stale order as-is used to hand back whatever QR
      // code/checkout link the FIRST attempt produced, regardless of
      // what was just clicked. The stale pending order/subscription is
      // cancelled here rather than left to rot — otherwise it would sit
      // there, still "pending", until its own TTL expiry.
      if (duplicate && duplicate.paymentMethod === dto.paymentMethod && duplicate.provider === providerName) {
        return { order: duplicate, reused: true as const };
      }
      if (duplicate) {
        await tx.order.update({ where: { id: duplicate.id }, data: { status: 'cancelled' } });
        if (duplicate.subscriptionId) {
          await tx.subscription.update({ where: { id: duplicate.subscriptionId }, data: { status: 'cancelled' } });
        }
      }

      const subscription = await this.subscriptions.createPendingSubscription(tx, userId, plan);
      await tx.subscription.update({ where: { id: subscription.id }, data: { paymentMethod: dto.paymentMethod, paymentProvider: providerName } });

      // No template/serverName/variables to snapshot anymore — the
      // customer hasn't chosen software yet (post-purchase setup flow,
      // see CreateCheckoutDto's own doc comment). Only `plan` is ever
      // read at provision time now (ProvisioningService.provisionOrder's
      // 'setup_pending' branch); the legacy fields stay optional on
      // OrderConfigSnapshot for orders placed before this change.
      const snapshot: OrderConfigSnapshot = {
        plan: { id: plan.id, name: plan.name, memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuLimitPercent: plan.cpuLimitPercent },
      };

      const configuredTtlMinutes = this.config.get<number>('CHECKOUT_ORDER_TTL_MINUTES') ?? 1440;
      // Boleto needs enough time for payment and bank compensation.
      // Three days is also Mercado Pago's recommended minimum.
      const ttlMinutes = dto.paymentMethod === 'boleto'
        ? Math.max(configuredTtlMinutes, 3 * 24 * 60)
        : configuredTtlMinutes;
      const order = await tx.order.create({
        data: {
          externalReference: this.generateExternalReference(),
          userId,
          planId: plan.id,
          subscriptionId: subscription.id,
          kind: 'plan_initial',
          amountCents: plan.priceCents,
          currency: plan.currency,
          status: 'pending',
          provider: providerName,
          paymentMethod: dto.paymentMethod,
          provisioningStatus: 'pending',
          expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
          config: snapshot as unknown as Prisma.InputJsonValue,
        },
      });

      return { order, reused: false as const, subscriptionId: subscription.id, planName: plan.name, billingPeriod: plan.billingPeriod as SubscriptionBillingPeriod };
    });

    if (created.reused) {
      return this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.order.findUniqueOrThrow({ where: { id: created.order.id }, select: ORDER_SELECT }));
    }

    const { order, subscriptionId, planName, billingPeriod } = created;

    await this.audit.record({
      action: 'payment.checkout.created',
      actorId: userId,
      targetType: 'order',
      targetId: order.id,
      metadata: { planId: dto.planId, subscriptionId, amountCents: order.amountCents, paymentMethod: dto.paymentMethod, provider: providerName },
    });

    return this.startProviderSubscription(order.id, subscriptionId, {
      userId,
      description: planName || 'Assinatura',
      amountCents: order.amountCents,
      currency: order.currency,
      paymentMethod: dto.paymentMethod,
      billingPeriod,
      expiresAt: order.expiresAt!,
      externalReference: order.externalReference,
      // Old clients may omit it during rollout: retain their established
      // same-email behavior. The current checkout always supplies it and
      // lets the customer choose a different Mercado Pago account.
      payerEmail: dto.payerEmail?.trim().toLowerCase(),
      provider: providerName,
    });
  }

  /**
   * Starts the charge at Mercado Pago. The two payment methods take
   * genuinely different Mercado Pago products, because Mercado Pago has
   * no single one that covers both:
   *
   *  - **Pix** → `POST /v1/payments`, ONE charge for ONE cycle, with the
   *    QR returned inline and rendered in-page. Mercado Pago has no
   *    recurring Pix product at all, so the subscription stays
   *    `autoRenew: false` and `BillingCycleProcessor` generates each
   *    next cycle's charge. There is no provider-side subscription
   *    object, which is why `externalSubscriptionId` stays null for pix
   *    — a Pix payment is matched back to its order by
   *    `externalReference` instead (see `PaymentsWebhookService`).
   *  - **Card** → `POST /preapproval`, a real recurring subscription
   *    Mercado Pago schedules and charges itself. The customer
   *    authorizes it on Mercado Pago's own hosted page (`init_point`),
   *    so no card number, CVV or expiry ever reaches this platform.
   *
   * Deliberately NOT inside the transaction that created the order/
   * subscription: an outbound HTTP call must never hold `lockPlan`'s
   * advisory lock (the exact reason `ServersService.createOnNode` keeps
   * agent dispatch out of ITS transaction too).
   *
   * Nothing here activates anything. The synchronous response is trusted
   * enough to FAIL the order on a provider error, never to mark it paid
   * — that stays exclusively the webhook's job.
   */
  private async startProviderSubscription(
    orderId: string,
    subscriptionId: string,
    input: {
      userId: string;
      description: string;
      amountCents: number;
      currency: string;
      paymentMethod: PaymentMethod;
      billingPeriod: SubscriptionBillingPeriod;
      expiresAt: Date;
      externalReference: string;
      payerEmail?: string;
      provider: PaymentProviderName;
    },
  ) {
    try {
      const provider = this.providers.get(input.provider);
      const profile = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => this.loadBillingProfile(tx, input.userId));
      const payer = this.toPayerInput(profile, input.payerEmail);

      if (input.paymentMethod === 'pix') {
        const charge = await provider.createPixCharge({
          payer,
          amountCents: input.amountCents,
          currency: input.currency,
          description: input.description,
          externalReference: input.externalReference,
          // Derived from the order, so a retried checkout request can
          // never produce a second charge at Mercado Pago.
          idempotencyKey: `order-${orderId}`,
          expiresAt: input.expiresAt,
        });
        await this.payments.recordFromGateway(orderId, charge);
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({ where: { id: orderId }, data: { pixQrCode: charge.qrCode, pixQrCodeBase64: charge.qrCodeBase64 } }),
        );
      } else if (input.paymentMethod === 'boleto') {
        const charge = await provider.createBoletoCharge({
          payer,
          amountCents: input.amountCents,
          currency: input.currency,
          description: input.description,
          externalReference: input.externalReference,
          idempotencyKey: `order-${orderId}`,
          expiresAt: input.expiresAt,
        });
        await this.payments.recordFromGateway(orderId, charge);
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({
            where: { id: orderId },
            data: {
              boletoDigitableLine: charge.digitableLine,
              boletoUrl: charge.ticketUrl,
              expiresAt: charge.expiresAt ?? input.expiresAt,
            },
          }),
        );
      } else {
        const preapproval = await provider.createCardSubscription({
          payer,
          amountCents: input.amountCents,
          currency: input.currency,
          description: input.description,
          externalReference: input.externalReference,
          idempotencyKey: `order-${orderId}`,
          billingPeriod: input.billingPeriod,
          backUrl: this.checkoutReturnUrl(orderId),
        });
        await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
          await tx.subscription.update({ where: { id: subscriptionId }, data: { externalSubscriptionId: preapproval.id } });
          await tx.order.update({ where: { id: orderId }, data: { checkoutUrl: preapproval.initPoint, externalPreferenceId: preapproval.id } });
        });
      }
    } catch (err) {
      // Never leave the Order (and the Subscription it holds a slot
      // for) sitting in `pending` forever with no visible outcome —
      // same "order failed, subscription stays pending for a retry"
      // shape the webhook's own rejected-payment branch already uses.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.update({ where: { id: orderId }, data: { status: 'failed' } }));
      this.logger.error(`checkout failed for order ${orderId}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof PaymentProviderRequestError) {
        const providerRejectedData = err.status >= 400 && err.status < 500;
        throw new HttpException(
          providerRejectedData
            ? 'O provedor de pagamento recusou os dados da cobrança. Confira seus dados cadastrais e tente novamente.'
            : 'O provedor de pagamento está indisponível. Tente novamente em instantes.',
          providerRejectedData ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_GATEWAY,
        );
      }
      throw err;
    }

    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_SELECT }));
  }

  /**
   * Generates the NEXT cycle's Pix charge for a subscription, called by
   * `BillingCycleProcessor` as a period is about to turn over.
   *
   * This exists because Mercado Pago has no recurring Pix product at
   * all: `/preapproval` is card-only. So for pix this platform is the
   * scheduler — each cycle is its own `plan_renewal` order and its own
   * `POST /v1/payments`, and an unpaid one simply expires (which is
   * what moves the subscription to `past_due`, feeding the existing
   * grace-period and suspension logic untouched).
   *
   * Idempotent in two independent layers, because a daily job WILL run
   * twice eventually: it refuses to create a second charge while an
   * unexpired pending renewal order exists, and the charge itself
   * carries an `X-Idempotency-Key` derived from the order id, so even a
   * retry that got past the first check cannot produce two charges at
   * Mercado Pago.
   *
   * Returns the created order's id, or `null` when there was already a
   * live renewal order (the common case on the second run of a day).
   */
  async createOfflineRenewalCharge(subscriptionId: string): Promise<string | null> {
    const prepared = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await tx.subscription.findFirst({ where: { id: subscriptionId } });
      if (!subscription || (subscription.paymentMethod !== 'pix' && subscription.paymentMethod !== 'boleto')) return null;

      const existing = await tx.order.findFirst({
        where: { subscriptionId, kind: 'plan_renewal', status: 'pending', expiresAt: { gt: new Date() } },
      });
      if (existing) return null;

      // The Pix stays payable through the whole grace window — a charge
      // generated days before the period ends must not expire before
      // the customer is even late.
      const graceDays = this.config.get<number>('BILLING_GRACE_DAYS') ?? 3;
      const periodEnd = subscription.currentPeriodEndsAt ?? new Date();
      const paymentMethod = subscription.paymentMethod as 'pix' | 'boleto';
      const expiresAt = clampOfflineExpiry(
        paymentMethod,
        new Date(periodEnd.getTime() + graceDays * 24 * 60 * 60 * 1000),
      );

      const order = await tx.order.create({
        data: {
          externalReference: this.generateExternalReference(),
          userId: subscription.userId,
          planId: subscription.planId,
          subscriptionId: subscription.id,
          kind: 'plan_renewal',
          // The price SNAPSHOTTED on the subscription, never the plan's
          // current price — a plan repricing never silently changes what
          // an existing customer is charged.
          amountCents: subscription.priceCents,
          currency: subscription.currency,
          status: 'pending',
          provider: subscription.paymentProvider,
          paymentMethod,
          provisioningStatus: 'not_required', // the server already exists; a renewal only extends the period
          expiresAt,
          config: {} as unknown as Prisma.InputJsonValue,
        },
      });

      const profile = await this.loadBillingProfile(tx, subscription.userId);
      const plan = await tx.plan.findFirst({ where: { id: subscription.planId }, select: { name: true } });
      return { order, profile, planName: plan?.name ?? 'Assinatura', expiresAt, providerName: subscription.paymentProvider, paymentMethod };
    });

    if (!prepared) return null;
    const { order, profile, planName, expiresAt, providerName, paymentMethod } = prepared;

    try {
      const provider = this.providers.get(providerName);
      const chargeInput = {
        payer: this.toPayerInput(profile),
        amountCents: order.amountCents,
        currency: order.currency,
        description: planName,
        externalReference: order.externalReference,
        idempotencyKey: `order-${order.id}`,
        expiresAt,
      };
      let paymentId: string;
      if (paymentMethod === 'pix') {
        const charge = await provider.createPixCharge(chargeInput);
        paymentId = charge.id;
        await this.payments.recordFromGateway(order.id, charge);
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({
            where: { id: order.id },
            data: { pixQrCode: charge.qrCode, pixQrCodeBase64: charge.qrCodeBase64 },
          }),
        );
      } else {
        const charge = await provider.createBoletoCharge(chargeInput);
        paymentId = charge.id;
        await this.payments.recordFromGateway(order.id, charge);
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({
            where: { id: order.id },
            data: {
              boletoDigitableLine: charge.digitableLine,
              boletoUrl: charge.ticketUrl,
              expiresAt: charge.expiresAt ?? expiresAt,
            },
          }),
        );
      }
      await this.audit.record({
        action: 'payment.renewal.created',
        targetType: 'order',
        targetId: order.id,
        metadata: { subscriptionId, amountCents: order.amountCents, paymentId, paymentMethod },
      });
      return order.id;
    } catch (err) {
      // Fail the ORDER, never the subscription — the customer is not
      // late yet, and the next daily run will try again with a fresh
      // order. Leaving it `pending` instead would block that retry via
      // the duplicate guard above.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.update({ where: { id: order.id }, data: { status: 'failed' } }));
      this.logger.error(`${paymentMethod} renewal charge failed for subscription ${subscriptionId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Compatibility seam for callers/tests written before boleto support. */
  async createPixRenewalCharge(subscriptionId: string): Promise<string | null> {
    return this.createOfflineRenewalCharge(subscriptionId);
  }

  /**
   * Cancels at the provider FIRST — Mercado Pago stops charging the
   * card the moment the preapproval is cancelled, regardless of
   * `atPeriodEnd` below. (A pix subscription has no preapproval to
   * cancel at all: nothing is scheduled at Mercado Pago, so cancelling
   * simply means this platform stops generating the next cycle's
   * charge.) That flag only changes what happens to THIS platform's own
   * `Subscription`/server:
   *  - immediate (default): `Subscription` moves to `cancelled` now
   *    (`SubscriptionsService.cancelForUser` — the customer's only
   *    self-service transition).
   *  - `atPeriodEnd: true`: `Subscription` stays exactly as it is
   *    (server keeps running) with `cancelAtPeriodEnd` set; billing-cycle
   *    finishes the cancellation once `currentPeriodEndsAt` passes,
   *    never generating a renewal order for it (the provider-side
   *    subscription is already gone, so none would arrive anyway).
   */
  async cancelSubscriptionForUser(userId: string, subscriptionId: string, opts: { reason?: string; atPeriodEnd?: boolean }) {
    const subscription = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.subscription.findFirst({ where: { id: subscriptionId, userId } }));
    if (!subscription) throw new NotFoundException('Subscription not found');

    if (subscription.externalSubscriptionId) {
      try {
        await this.providers.get(subscription.paymentProvider).cancelSubscription(subscription.externalSubscriptionId);
      } catch (err) {
        // Never silently swallowed — if Mercado Pago is unreachable, the
        // customer's cancel request still fails loudly rather than
        // leaving them believing they stopped a subscription that's
        // still actively billing.
        this.logger.error(`failed to cancel subscription ${subscription.id} at ${subscription.paymentProvider}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    if (opts.atPeriodEnd && (subscription.status === 'active' || subscription.status === 'past_due')) {
      const updated = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
        tx.subscription.update({ where: { id: subscriptionId }, data: { cancelAtPeriodEnd: true, cancelReason: opts.reason ?? null } }),
      );
      await this.audit.record({ action: 'subscription.cancel_at_period_end', actorId: userId, targetType: 'subscription', targetId: subscriptionId, metadata: { reason: opts.reason ?? null } });
      return updated;
    }

    return this.subscriptions.cancelForUser(userId, subscriptionId, { reason: opts.reason });
  }

  async listForUser(userId: string) {
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.order.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: ORDER_SELECT }),
    );
  }

  /** 404, not 403, for an order that exists but belongs to someone else — same anti-enumeration posture `SubscriptionsService.getForUser` already applies. This is also what the client's payment status page polls — it must never assume payment succeeded just because the customer landed on it (payments plan's central rule). */
  async getForUser(userId: string, id: string) {
    const order = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.order.findFirst({ where: { id, userId }, select: ORDER_SELECT }));
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async listForAdmin(dto: ListOrdersDto) {
    const take = dto.limit ?? 50;
    const skip = dto.offset ?? 0;

    const where: Prisma.OrderWhereInput = {
      archivedAt: null,
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.paymentMethod ? { paymentMethod: dto.paymentMethod } : {}),
      ...(dto.planId ? { planId: dto.planId } : {}),
      ...(dto.q ? { user: { OR: [{ email: { contains: dto.q } }, { username: { contains: dto.q } }] } } : {}),
    };

    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const [items, total] = await Promise.all([
        tx.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: {
            ...ORDER_SELECT,
            user: { select: { id: true, email: true, username: true } },
            plan: { select: { id: true, name: true } },
            server: { select: { id: true, name: true, nodeId: true } },
          },
        }),
        tx.order.count({ where }),
      ]);
      return { items, total, limit: take, offset: skip };
    });
  }

  async getForAdmin(id: string) {
    const order = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.order.findFirst({
        where: { id },
        select: {
          ...ORDER_SELECT,
          user: { select: { id: true, email: true, username: true } },
          plan: { select: { id: true, name: true } },
          server: { select: { id: true, name: true, nodeId: true } },
          payments: { orderBy: { createdAt: 'desc' } },
          webhookEvents: { orderBy: { receivedAt: 'desc' } },
        },
      }),
    );
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Re-enqueues the SAME deterministic job (`ProvisioningQueueService`'s own `provision-<orderId>` jobId) — an admin retry is otherwise indistinguishable from the webhook's own automatic enqueue, going through the identical idempotent path (payments plan step 8). Refuses for anything but a paid order with failed provisioning — retrying a `pending`/unpaid order would attempt to provision something never actually purchased. */
  async retryProvisioningAsAdmin(orderId: string, actorId: string) {
    const order = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.findFirst({ where: { id: orderId } }));
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'paid' || order.provisioningStatus !== 'failed') {
      throw new ConflictException('ORDER_NOT_RETRYABLE: only a paid order with failed provisioning can be retried');
    }
    await this.audit.record({ action: 'admin.order.retry_provisioning', actorId, targetType: 'order', targetId: orderId });
    await this.provisioningQueue.enqueue(orderId);
    return { enqueued: true };
  }

  /**
   * Triggers the refund AT the provider — never marks the order/payment
   * `refunded` itself. That state change happens exclusively through
   * the SAME `PaymentRefunded` webhook path a customer-initiated or
   * dashboard-side refund already goes through
   * (`PaymentsWebhookService`'s own doc comment) — a second, admin-only
   * code path setting `status: 'refunded'` directly would let this
   * endpoint's belief about the refund's outcome diverge from what
   * Mercado Pago actually did.
   */
  async refundAsAdmin(orderId: string, reason: string, actorId: string) {
    const order = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.order.findFirst({ where: { id: orderId }, include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
    );
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'paid') {
      throw new ConflictException('ORDER_NOT_REFUNDABLE: only a paid order can be refunded');
    }
    const latestPayment = order.payments[0];
    if (!latestPayment) {
      throw new ConflictException('ORDER_NOT_REFUNDABLE: no payment on file for this order');
    }

    const result = await this.providers.get(order.provider).refund(latestPayment.id);
    await this.audit.record({
      action: 'admin.order.refund',
      actorId,
      targetType: 'order',
      targetId: orderId,
      metadata: { reason, paymentId: latestPayment.id, providerStatus: result.status },
    });
    return { requested: true, providerStatus: result.status };
  }

  /**
   * Hides orders from the admin listing — never a delete. `DELETE` is
   * revoked from the app role on this table (financial history is
   * never destroyed, see the `archivedAt` field's own doc comment in
   * schema.prisma), so this is the only "remove from view" an admin
   * can have. Every field, every `Payment`/`PaymentWebhookEvent` row
   * pointing at these orders, and every other code path (webhooks,
   * provisioning, billing) is completely unaffected — only
   * `listForAdmin`'s default filter reads this column.
   *
   * Scoped to exactly the given ids (never a broad `WHERE`), matching
   * the lesson from the mass plan-deletion incident this session
   * already root-caused. One audit row per order, not one batched row
   * — the same convention `retryProvisioningAsAdmin`/`refundAsAdmin`
   * already establish for a single-entity `targetId`.
   */
  async archiveOrdersAsAdmin(orderIds: string[], actorId: string): Promise<{ archived: number }> {
    const ids = [...new Set(orderIds)];
    const archivedIds = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const matches = await tx.order.findMany({ where: { id: { in: ids }, archivedAt: null }, select: { id: true } });
      if (matches.length === 0) return [];
      await tx.order.updateMany({ where: { id: { in: matches.map((m) => m.id) } }, data: { archivedAt: new Date() } });
      return matches.map((m) => m.id);
    });
    await Promise.all(archivedIds.map((id) => this.audit.record({ action: 'admin.order.archived', actorId, targetType: 'order', targetId: id })));
    return { archived: archivedIds.length };
  }
}

/**
 * Validates checkout-submitted variable values against the SAME
 * `variable-rules.ts` validator `ServerVariablesService.update` already
 * enforces for an existing server, and rejects anything not BOTH
 * `isUserViewable` and `isUserEditable` outright (never silently
 * dropped) — a customer choosing checkout config gets exactly the same
 * guarantees as one editing a server's startup variables afterward.
 * Returns the FULL resolved variable map (every declared variable,
 * defaults filled in) — this is what `ProvisioningService` passes
 * straight to `ServersService.create`.
 */
// validateCheckoutVariables moved to
// ../servers/variable-resolution.ts (resolveDeclaredVariables) —
// checkout no longer collects a template/variables at all (see
// CreateCheckoutDto's doc comment); ServerSetupService.complete is its
// only caller now.

/**
 * Mercado Pago refuses a `date_of_expiration` more than 30 days out.
 * A long billing period plus a grace window can exceed that, so the
 * charge is clamped: the Pix expires earlier than the grace window
 * ends, and the next daily run simply issues a fresh one.
 */
function clampToMercadoPagoMaxExpiry(requested: Date): Date {
  const max = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
  return requested > max ? max : requested;
}

function clampOfflineExpiry(paymentMethod: 'pix' | 'boleto', requested: Date): Date {
  const minimum = paymentMethod === 'boleto'
    ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    : requested;
  return clampToMercadoPagoMaxExpiry(requested < minimum ? minimum : requested);
}
