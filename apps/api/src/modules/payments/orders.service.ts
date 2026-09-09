import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
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
import { validateVariableValue } from '../servers/variable-rules';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.interface';
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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
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
   * `Order.externalReference` — kept as the checkout's own idempotency
   * anchor even though the Asaas migration moved the webhook's PRIMARY
   * lookup key to `Subscription.externalSubscriptionId`/`Payment.
   * subscriptionExternalId` (see `PaymentsWebhookService`'s own doc
   * comment). Still server-generated, never accepted from the client,
   * still 192 bits — never plausibly guessable or reused.
   */
  private generateExternalReference(): string {
    return `ord_${randomBytes(24).toString('base64url')}`;
  }

  /**
   * Creates (or reuses) this user's customer record at the payment
   * provider — `PaymentCustomer` is the persistence, keyed `(provider,
   * userId)`, so a customer is only ever created at Asaas once. A race
   * between two concurrent checkouts for a user with no row yet is
   * resolved by falling back to a re-read on a unique-constraint
   * conflict, rather than creating two Asaas customers for one user.
   */
  private async ensureCustomer(profile: BillingProfile): Promise<string> {
    const existing = await this.prisma.paymentCustomer.findFirst({
      where: { provider: this.provider.name, userId: profile.userId },
    });
    if (existing) return existing.externalCustomerId;

    const created = await this.provider.ensureCustomer({
      userId: profile.userId,
      email: profile.email,
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
    });

    try {
      await this.prisma.paymentCustomer.create({
        data: { userId: profile.userId, provider: this.provider.name, externalCustomerId: created.externalCustomerId },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Lost the race — another request created this user's
        // PaymentCustomer row first. Their externalCustomerId is
        // authoritative; the one Asaas just returned us is an orphaned
        // duplicate customer at Asaas, harmless but unused.
        const winner = await this.prisma.paymentCustomer.findFirst({ where: { provider: this.provider.name, userId: profile.userId } });
        if (winner) return winner.externalCustomerId;
      }
      throw err;
    }

    return created.externalCustomerId;
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
   * once that's safely committed — creates the Asaas customer (if
   * needed) and the recurring subscription itself. Asaas's own
   * scheduler generates every future charge from here on; this platform
   * never calls a separate "renew" endpoint again (the Mercado-Pago-era
   * `renewForUser` is gone — see this module's git history).
   *
   * Idempotency (payments plan §24): if this user already has a
   * `pending` Subscription with a `pending`, unexpired Order on the SAME
   * plan, THAT order is returned instead of creating a second one — a
   * double-click or a retried request never creates two subscriptions.
   */
  async createCheckoutOrder(userId: string, dto: CreateCheckoutDto, meta: { ip: string | null }) {
    await this.checkCheckoutRateLimit(userId, meta.ip);

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
      if (duplicate) return { order: duplicate, reused: true as const };

      const template = await tx.serverTemplate.findFirst({
        where: { id: dto.templateId, deletedAt: null },
        include: { group: true, variables: true },
      });
      if (!template) throw new NotFoundException('Template not found');
      if (!template.isActive || !template.isPublic) {
        throw new ConflictException('Template is not available for checkout');
      }

      const config = validateCheckoutVariables(template.variables, dto.variables ?? {});

      const subscription = await this.subscriptions.createPendingSubscription(tx, userId, plan);
      await tx.subscription.update({ where: { id: subscription.id }, data: { paymentMethod: dto.paymentMethod } });

      const snapshot: OrderConfigSnapshot = {
        serverName: dto.serverName,
        template: { id: template.id, name: template.name, groupId: template.groupId, groupName: template.group.name },
        variables: config,
        plan: { id: plan.id, name: plan.name, memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuLimitPercent: plan.cpuLimitPercent },
      };

      const ttlMinutes = this.config.get<number>('CHECKOUT_ORDER_TTL_MINUTES') ?? 1440;
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
      metadata: { planId: dto.planId, templateId: dto.templateId, subscriptionId, amountCents: order.amountCents, paymentMethod: dto.paymentMethod },
    });

    return this.startProviderSubscription(order.id, subscriptionId, {
      userId,
      description: planName || 'Assinatura',
      amountCents: order.amountCents,
      currency: order.currency,
      paymentMethod: dto.paymentMethod,
      billingPeriod,
      externalReference: order.externalReference,
    });
  }

  /**
   * Creates the recurring subscription at Asaas and captures whatever
   * the customer needs to complete the FIRST charge (a Pix QR shown
   * in-page, or the `invoiceUrl` for a card charge — Asaas's own hosted
   * checkout, per the "checkout hospedado" decision: card data never
   * touches this platform at all). Deliberately NOT inside the
   * transaction that created the order/subscription: an outbound HTTP
   * call must never hold `lockPlan`'s advisory lock (the exact reason
   * `ServersService.createOnNode` keeps agent dispatch out of ITS
   * transaction too).
   *
   * `Subscription.autoRenew` is set only once the webhook confirms the
   * first payment (see `PaymentsWebhookService`'s own doc comment) — the
   * synchronous response here is trusted enough to FAIL the order on a
   * provider error, never to activate anything itself.
   */
  private async startProviderSubscription(
    orderId: string,
    subscriptionId: string,
    input: {
      userId: string;
      description: string;
      amountCents: number;
      currency: string;
      paymentMethod: 'pix' | 'card';
      billingPeriod: SubscriptionBillingPeriod;
      externalReference: string;
    },
  ) {
    try {
      const profile = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => this.loadBillingProfile(tx, input.userId));
      const externalCustomerId = await this.ensureCustomer(profile);

      const gatewaySubscription = await this.provider.createSubscription({
        externalCustomerId,
        externalReference: input.externalReference,
        description: input.description,
        amountCents: input.amountCents,
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        billingPeriod: input.billingPeriod,
        firstDueDate: new Date(),
      });

      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
        tx.subscription.update({ where: { id: subscriptionId }, data: { externalSubscriptionId: gatewaySubscription.id } }),
      );

      const charges = await this.provider.listSubscriptionPayments(gatewaySubscription.id);
      const firstCharge = charges[0];
      if (!firstCharge) {
        throw new Error('Asaas subscription created with no initial charge');
      }
      await this.payments.recordFromGateway(orderId, firstCharge);

      if (input.paymentMethod === 'pix') {
        const qr = await this.provider.getPixQrCode(firstCharge.id);
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({ where: { id: orderId }, data: { pixQrCode: qr.qrCode, pixQrCodeBase64: qr.qrCodeBase64 } }),
        );
      } else {
        await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
          tx.order.update({ where: { id: orderId }, data: { checkoutUrl: firstCharge.invoiceUrl } }),
        );
      }
    } catch (err) {
      // Never leave the Order (and the Subscription it holds a slot
      // for) sitting in `pending` forever with no visible outcome —
      // same "order failed, subscription stays pending for a retry"
      // shape the webhook's own rejected-payment branch already uses.
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.update({ where: { id: orderId }, data: { status: 'failed' } }));
      this.logger.error(`checkout failed for order ${orderId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_SELECT }));
  }

  /**
   * Cancels at the provider FIRST — Asaas stops generating any further
   * charge for this subscription the moment this call succeeds,
   * regardless of `atPeriodEnd` below. That flag only changes what
   * happens to THIS platform's own `Subscription`/server:
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
        await this.provider.cancelSubscription(subscription.externalSubscriptionId);
      } catch (err) {
        // Never silently swallowed — if Asaas is unreachable, the
        // customer's cancel request still fails loudly rather than
        // leaving them believing they stopped a subscription that's
        // still actively billing.
        this.logger.error(`failed to cancel subscription ${subscription.id} at Asaas: ${err instanceof Error ? err.message : String(err)}`);
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
   * Asaas-side refund already goes through (`PaymentsWebhookService`'s
   * own doc comment) — a second, admin-only code path setting
   * `status: 'refunded'` directly would let this endpoint's belief
   * about the refund's outcome diverge from what Asaas actually did.
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

    const result = await this.provider.refund(latestPayment.id);
    await this.audit.record({
      action: 'admin.order.refund',
      actorId,
      targetType: 'order',
      targetId: orderId,
      metadata: { reason, paymentId: latestPayment.id, providerStatus: result.status },
    });
    return { requested: true, providerStatus: result.status };
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
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
function validateCheckoutVariables(
  templateVars: { envVariable: string; name: string; defaultValue: string; rules: string; isUserViewable: boolean; isUserEditable: boolean }[],
  requested: Record<string, string>,
): Record<string, string> {
  const byEnvVar = new Map(templateVars.map((tv) => [tv.envVariable, tv]));

  for (const [key, value] of Object.entries(requested)) {
    const tv = byEnvVar.get(key);
    if (!tv) throw new BadRequestException(`Variável desconhecida: ${key}`);
    if (!tv.isUserViewable || !tv.isUserEditable) throw new ForbiddenException(`Variável não configurável: ${key}`);
    const error = validateVariableValue(value, tv.rules);
    if (error) throw new BadRequestException(`${tv.name}: ${error}`);
  }

  const resolved: Record<string, string> = {};
  for (const tv of templateVars) {
    resolved[tv.envVariable] = requested[tv.envVariable] ?? tv.defaultValue;
  }
  return resolved;
}
