import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CapacityService } from '../capacity/capacity.service';
import { assertSlots } from '../capacity/capacity.math';
import { AuditService } from '../audit/audit.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';
import { assertTransition, nextPeriodEnd, SubscriptionBillingPeriod, SubscriptionStatus } from './subscription-status';

/** Only the fields a "my subscription" / "admin subscription" view actually needs from the plan it references — never the node-tuning columns (cpuPinning, blockIo*, ...), the same allowlist discipline PLAN_CLIENT_SELECT already applies. */
const SUBSCRIPTION_PLAN_SELECT = {
  id: true,
  name: true,
  slug: true,
  memoryMb: true,
  diskMb: true,
  cpuLimitPercent: true,
} satisfies Prisma.PlanSelect;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a pending subscription for the calling customer. Runs
   * entirely under an ADMIN RLS context, NOT the actor's own — same
   * requirement `occupiedSlots` already documents for
   * `PublicPlansService`, and the exact bug class that shipped here
   * first: `occupiedSlots` counts SUBSCRIPTIONS ACROSS EVERY CUSTOMER
   * on this plan, but the `subscriptions_tenant` RLS policy restricts a
   * non-admin session to rows where `user_id = current_app_user()` —
   * under the caller's own context, two different customers subscribing
   * to the SAME 1-slot plan each only ever see THEIR OWN (zero) rows,
   * both read "0 occupied," and both slip through `assertSlots`,
   * overselling the plan. Proven live by this file's own e2e test
   * before this comment existed. Ownership is still enforced — just not
   * by RLS's `WITH CHECK` on this path — by writing `userId` from the
   * authenticated caller (`@CurrentUser()`, never `dto`), the same
   * "admin context, but the actor id comes from the JWT" posture
   * `PlansService.applyToServers` and `ServersService.createOnNode`
   * already take for their own admin-context writes.
   *
   * Price/RAM/CPU/disk are never read from dto — only planId is client
   * input (commercial plan's security section: never trust a price sent
   * by the frontend). Everything else is read from the plans row itself,
   * under CapacityService.lockPlan — the same lock-then-read ordering
   * ServersService.createOnNode already uses, for the identical reason
   * (a plan edited mid-request must never be read twice with two
   * different values).
   */
  async createForUser(userId: string, dto: CreateSubscriptionDto) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const plan = await this.lockAndValidatePlanForSubscription(tx, dto.planId);
      return this.createPendingSubscription(tx, userId, plan);
    });
  }

  /**
   * The plan-side half of `createForUser`, split out so
   * `OrdersService.createCheckoutOrder` (payments plan step 4) can lock
   * and validate the SAME plan, then also validate a template/server
   * config, before creating the pending subscription — all inside ONE
   * transaction. Must be called with a `tx` the caller keeps open until
   * `createPendingSubscription` below has run: `capacity.lockPlan`'s
   * advisory lock is transaction-scoped (auto-released at commit), and
   * releasing it between the plan check and the slots check would
   * reopen the exact oversell race this lock exists to close.
   */
  async lockAndValidatePlanForSubscription(tx: Prisma.TransactionClient, planId: string) {
    await this.capacity.lockPlan(tx, planId);
    const plan = await tx.plan.findFirst({ where: { id: planId, deletedAt: null, isPublic: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.billingPeriod === 'none') {
      // A plan marked 'none' is not sold on a recurring basis (e.g. an
      // internal/legacy plan an admin never intended for self-service
      // — see Plan.billingPeriod's own doc comment) — not a slots
      // problem, so a distinct message from NO_SLOTS below.
      throw new ConflictException('PLAN_NOT_SUBSCRIBABLE: this plan is not sold on a recurring basis');
    }
    return plan;
  }

  /**
   * The billing-profile + slots + subscription-row half of
   * `createForUser`, taking an already-locked-and-validated `plan` (see
   * `lockAndValidatePlanForSubscription` above) so a second caller
   * (`OrdersService`) can create an `Order` in the SAME transaction,
   * right after this returns — see `CapacityService.occupiedSlots`'s own
   * doc comment for why creating the Subscription and its Order in two
   * SEPARATE transactions would momentarily double-count a slot (a
   * subscription with `serverId: null` and no order counts once; one
   * mid-way through being attached to an order/server must never count
   * twice, nor zero).
   */
  async createPendingSubscription(tx: Prisma.TransactionClient, userId: string, plan: { id: string; maxSlots: number | null; priceCents: number; currency: string; billingPeriod: string }) {
    // The frontend gates the "Confirmar assinatura"/"Ir para o
    // pagamento" button on a complete billing profile, but that's UX,
    // not enforcement — same "never trust the frontend" posture this
    // method already applies to price/RAM/CPU/disk. complement is the
    // one field that's always optional (see UpdateAccountDto).
    const billing = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        cpf: true,
        billingPostalCode: true,
        billingAddressLine: true,
        billingAddressNumber: true,
        billingNeighborhood: true,
        billingCity: true,
        billingState: true,
      },
    });
    const billingComplete = Object.values(billing).every((v) => v !== null && v !== '');
    if (!billingComplete) {
      throw new ConflictException('BILLING_PROFILE_REQUIRED: complete seus dados de cobrança antes de assinar');
    }

    const occupied = await this.capacity.occupiedSlots(tx, plan.id);
    assertSlots(occupied, plan.maxSlots); // throws a NO_SLOTS: ConflictException — same message class ServersService.create already surfaces

    const subscription = await tx.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'pending',
        priceCents: plan.priceCents,
        currency: plan.currency,
        billingPeriod: plan.billingPeriod,
      },
    });

    await tx.subscriptionEvent.create({
      data: { subscriptionId: subscription.id, fromStatus: null, toStatus: 'pending', actorId: userId },
    });

    return subscription;
  }

  async listForUser(userId: string) {
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: SUBSCRIPTION_PLAN_SELECT } },
      }),
    );
  }

  /** 404, not 403, for a subscription that exists but belongs to someone else — the same anti-enumeration posture ServerAccessService already applies to another customer's server (commercial plan's security section). */
  async getForUser(userId: string, id: string) {
    return this.prisma.withRLS({ userId, isAdmin: false }, async (tx) => {
      const subscription = await tx.subscription.findFirst({
        where: { id, userId },
        include: { plan: { select: SUBSCRIPTION_PLAN_SELECT }, events: { orderBy: { createdAt: 'asc' } } },
      });
      if (!subscription) throw new NotFoundException('Subscription not found');
      return subscription;
    });
  }

  /**
   * The ONLY status change a customer may make themselves (commercial
   * plan: "opcao de cancelar, caso o backend suporte") — every other
   * transition, including the only path into active, is admin-only
   * (updateStatusAsAdmin below). assertTransition is what actually
   * enforces that this call can never reach anything but cancelled.
   */
  async cancelForUser(userId: string, id: string, dto: CancelSubscriptionDto) {
    return this.prisma.withRLS({ userId, isAdmin: false }, async (tx) => {
      const subscription = await tx.subscription.findFirst({ where: { id, userId } });
      if (!subscription) throw new NotFoundException('Subscription not found');

      const from = subscription.status as SubscriptionStatus;
      assertTransition(from, 'cancelled');

      const updated = await tx.subscription.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: dto.reason ?? null },
      });
      await tx.subscriptionEvent.create({
        data: { subscriptionId: id, fromStatus: from, toStatus: 'cancelled', actorId: userId, reason: dto.reason ?? null },
      });
      return updated;
    });
  }

  async listForAdmin(dto: ListSubscriptionsDto) {
    const take = dto.limit ?? 50;
    const skip = dto.offset ?? 0;

    const where: Prisma.SubscriptionWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.planId ? { planId: dto.planId } : {}),
      ...(dto.q ? { user: { OR: [{ email: { contains: dto.q } }, { username: { contains: dto.q } }] } } : {}),
    };

    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const [items, total] = await Promise.all([
        tx.subscription.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          include: {
            plan: { select: SUBSCRIPTION_PLAN_SELECT },
            user: { select: { id: true, email: true, username: true } },
          },
        }),
        tx.subscription.count({ where }),
      ]);
      return { items, total, limit: take, offset: skip };
    });
  }

  async getForAdmin(id: string) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const subscription = await tx.subscription.findFirst({
        where: { id },
        include: {
          plan: { select: SUBSCRIPTION_PLAN_SELECT },
          user: { select: { id: true, email: true, username: true } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!subscription) throw new NotFoundException('Subscription not found');
      return subscription;
    });
  }

  /**
   * The transition machinery shared by `updateStatusAsAdmin` (a human
   * acting) and the payments webhook (the system acting — payments plan
   * step 5, `actorId: null`; `SubscriptionEvent.actorId` is nullable
   * exactly for this, see its own doc comment) — ONE state machine, two
   * callers, so a webhook-driven activation and an admin's manual one
   * can never quietly diverge on what counts as a legal move.
   *
   * Activating computes `currentPeriodEndsAt` from THIS moment, not from
   * whenever the subscription was created — a subscription can sit
   * `pending` for days before payment confirms, and "next billing date"
   * has to count from when billing actually started. (A RENEWAL's period
   * math is deliberately different — see `applyRenewal` below, which
   * does NOT go through this method.)
   */
  async applyTransition(tx: Prisma.TransactionClient, id: string, to: SubscriptionStatus, opts: { actorId: string | null; reason?: string }) {
    const existing = await tx.subscription.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Subscription not found');

    const from = existing.status as SubscriptionStatus;
    assertTransition(from, to);

    const data: Prisma.SubscriptionUpdateInput = { status: to };
    if (to === 'active') {
      data.startedAt = existing.startedAt ?? new Date();
      data.currentPeriodEndsAt = nextPeriodEnd(new Date(), existing.billingPeriod as SubscriptionBillingPeriod);
    }
    if (to === 'cancelled') {
      data.cancelledAt = new Date();
      data.cancelReason = opts.reason ?? null;
    }

    const updated = await tx.subscription.update({ where: { id }, data });
    await tx.subscriptionEvent.create({
      data: { subscriptionId: id, fromStatus: from, toStatus: to, actorId: opts.actorId, reason: opts.reason ?? null },
    });
    return { subscription: updated, from };
  }

  /**
   * The ONLY path into active (commercial plan decision: only admin
   * activates — zero mock, zero auto-activation... now joined by the
   * payments webhook, an equally deliberate, non-mock path). Also the
   * general admin override for every other transition (suspend, mark
   * past_due, expire, cancel, or revert a mistaken suspension back to
   * active) — `applyTransition` above is the single gate that decides
   * which of those are legal from the subscription's current state,
   * shared with the customer's own `cancelForUser` so every entry point
   * agrees on what counts as a legal move.
   */
  async updateStatusAsAdmin(id: string, dto: UpdateSubscriptionStatusDto, actorId: string) {
    const { subscription, from } = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      this.applyTransition(tx, id, dto.status as SubscriptionStatus, { actorId, reason: dto.reason }),
    );

    await this.audit.record({
      action: 'admin.subscription.status',
      actorId,
      targetType: 'subscription',
      targetId: id,
      beforeState: { status: from },
      afterState: { status: subscription.status },
      metadata: dto.reason ? { reason: dto.reason } : undefined,
    });

    return subscription;
  }

  /**
   * A RENEWAL's period math (payments plan step 5) — deliberately NOT
   * `applyTransition`'s 'active' branch, which anchors the new period on
   * THE MOMENT OF ACTIVATION (correct for a first activation out of
   * `pending`, where there is no previous period to extend). A renewal
   * anchors on the subscription's OWN `currentPeriodEndsAt` instead: a
   * customer who pays a few days before expiry gets the full next period
   * added on top of what they already paid for, never silently
   * shortened by however early they renewed. Only actually TRANSITIONS
   * status when the subscription was `past_due` (clearing the overdue
   * flag); renewing an already-`active` subscription just extends the
   * date — no status change, no new SubscriptionEvent needed for that
   * case.
   */
  async applyRenewal(tx: Prisma.TransactionClient, id: string, actorId: string | null) {
    const existing = await tx.subscription.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Subscription not found');

    const from = existing.status as SubscriptionStatus;
    const anchor = existing.currentPeriodEndsAt && existing.currentPeriodEndsAt > new Date() ? existing.currentPeriodEndsAt : new Date();
    const currentPeriodEndsAt = nextPeriodEnd(anchor, existing.billingPeriod as SubscriptionBillingPeriod);

    if (from === 'past_due') {
      return this.applyTransition(tx, id, 'active', { actorId, reason: 'payment.webhook: renewal' }).then(async (result) => {
        // applyTransition's own 'active' branch re-anchors
        // currentPeriodEndsAt on "now" (correct for a FIRST activation,
        // wrong here) — overwrite it with the renewal's own anchor
        // immediately after, in the SAME transaction.
        const updated = await tx.subscription.update({ where: { id }, data: { currentPeriodEndsAt } });
        return { ...result, subscription: updated };
      });
    }

    const updated = await tx.subscription.update({ where: { id }, data: { currentPeriodEndsAt } });
    return { subscription: updated, from };
  }
}
