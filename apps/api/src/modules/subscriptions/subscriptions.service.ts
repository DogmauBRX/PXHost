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
      await this.capacity.lockPlan(tx, dto.planId);

      const plan = await tx.plan.findFirst({ where: { id: dto.planId, deletedAt: null, isPublic: true } });
      if (!plan) throw new NotFoundException('Plan not found');
      if (plan.billingPeriod === 'none') {
        // A plan marked 'none' is not sold on a recurring basis (e.g. an
        // internal/legacy plan an admin never intended for self-service
        // — see Plan.billingPeriod's own doc comment) — not a slots
        // problem, so a distinct message from NO_SLOTS below.
        throw new ConflictException('PLAN_NOT_SUBSCRIBABLE: this plan is not sold on a recurring basis');
      }

      const occupied = await this.capacity.occupiedSlots(tx, dto.planId);
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
    });
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
   * The ONLY path into active (commercial plan decision: only admin
   * activates — zero mock, zero auto-activation). Also the general admin
   * override for every other transition (suspend, mark past_due, expire,
   * cancel, or revert a mistaken suspension back to active) —
   * assertTransition is the single gate that decides which of those are
   * legal from the subscription's current state, shared with the
   * customer's own cancelForUser above so the two entry points can never
   * disagree about what counts as a legal move.
   *
   * Activating computes currentPeriodEndsAt from THIS moment, not from
   * whenever the subscription was created — a subscription can sit
   * pending for days before an admin confirms payment, and "next
   * billing date" has to count from when billing actually started.
   */
  async updateStatusAsAdmin(id: string, dto: UpdateSubscriptionStatusDto, actorId: string) {
    const { subscription, from } = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const existing = await tx.subscription.findFirst({ where: { id } });
      if (!existing) throw new NotFoundException('Subscription not found');

      const from = existing.status as SubscriptionStatus;
      const to = dto.status as SubscriptionStatus;
      assertTransition(from, to);

      const data: Prisma.SubscriptionUpdateInput = { status: to };
      if (to === 'active') {
        data.startedAt = existing.startedAt ?? new Date();
        data.currentPeriodEndsAt = nextPeriodEnd(new Date(), existing.billingPeriod as SubscriptionBillingPeriod);
      }
      if (to === 'cancelled') {
        data.cancelledAt = new Date();
        data.cancelReason = dto.reason ?? null;
      }

      const updated = await tx.subscription.update({ where: { id }, data });
      await tx.subscriptionEvent.create({
        data: { subscriptionId: id, fromStatus: from, toStatus: to, actorId, reason: dto.reason ?? null },
      });
      return { subscription: updated, from };
    });

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
}
