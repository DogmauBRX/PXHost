import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { SLOT_HOLDING_SUBSCRIPTION_STATUSES } from '../capacity/capacity.service';
import { PLAN_CLIENT_SELECT } from '../authorization/server-access.service';

/**
 * The catalog columns a VISITOR (not even logged in) may see — starts
 * from `PLAN_CLIENT_SELECT` (the same allowlist an authenticated
 * customer's "Meu Plano" page already uses) plus the three columns the
 * commercial site adds on top: the admin-picked highlight and the sort
 * order the public grid renders in. Never `maxSlots` itself (see
 * `availability` below, which is the ONLY vagas signal a visitor gets —
 * a raw slot count would leak how many customers a plan actually has),
 * never `cpuPinning`/`blockIo*`/anything node-shaped.
 */
const PLAN_PUBLIC_SELECT = {
  ...PLAN_CLIENT_SELECT,
  isFeatured: true,
  highlightLabel: true,
  sortOrder: true,
  maxSlots: true, // read internally to COMPUTE availability; stripped before the response leaves toPublicPlan()
} satisfies Prisma.PlanSelect;

type PlanRow = Prisma.PlanGetPayload<{ select: typeof PLAN_PUBLIC_SELECT }>;

export interface PlanAvailability {
  status: 'available' | 'limited' | 'sold_out';
  remaining: number | null;
}

const CACHE_KEY = 'public:plans:v1';
const CACHE_TTL_SECONDS = 30;
/** Below this many remaining slots (and above zero), the catalog nudges "poucas vagas" rather than a flat "available" — a UI hint only, never a second source of truth for whether a subscription can be created (that gate is `SubscriptionsService.createForUser`, under `lockPlan`, at request time). */
const LOW_STOCK_THRESHOLD = 3;

@Injectable()
export class PublicPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Called by `PlansService` right after any create/update/remove — the
   * catalog otherwise self-heals within `CACHE_TTL_SECONDS` regardless
   * (this is a freshness optimization, not a correctness dependency), so
   * a failed invalidation (Redis briefly down) is swallowed, never
   * allowed to fail the admin's plan edit that triggered it.
   */
  async invalidateCache(): Promise<void> {
    await this.redis.client.del(CACHE_KEY).catch(() => undefined);
  }

  /**
   * Occupancy for every plan is fetched in ONE batched query pair
   * (`occupancyForPlans`, mirroring `CapacityReportService.planUsage`'s
   * own `groupBy` approach), not one transaction PER plan — an earlier
   * version opened a fresh `withRLS` transaction for every single plan
   * and ran them all via `Promise.all`, which is exactly what exhausted
   * Prisma's connection pool ("Unable to start a transaction in the
   * given time", P2028) the moment the catalog had more plans than the
   * pool has connections. Batching fixed that; `computeAvailability`
   * itself is now pure and synchronous (see its own doc comment for
   * why), so there is no remaining per-plan I/O to serialize here.
   */
  async list() {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached) return JSON.parse(cached);

    const plans = await this.prisma.plan.findMany({
      where: { deletedAt: null, isPublic: true },
      select: PLAN_PUBLIC_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { memoryMb: 'asc' }],
    });

    const occupiedByPlan = await this.occupancyForPlans(plans.map((p) => p.id));
    const result = plans.map((plan) => this.toPublicPlan(plan, this.computeAvailability(plan.maxSlots, occupiedByPlan.get(plan.id) ?? 0)));

    await this.redis.client.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }

  async getBySlug(slug: string) {
    // Deliberately not cached individually — the list above already is,
    // and a plan-detail page is a low-traffic path compared to the grid;
    // one extra uncached query here keeps this method simple without a
    // second cache key to keep coherent with the first.
    const plan = await this.prisma.plan.findFirst({
      where: { slug, deletedAt: null, isPublic: true },
      select: PLAN_PUBLIC_SELECT,
    });
    if (!plan) throw new NotFoundException('Plan not found');
    const occupiedByPlan = await this.occupancyForPlans([plan.id]);
    return this.toPublicPlan(plan, this.computeAvailability(plan.maxSlots, occupiedByPlan.get(plan.id) ?? 0));
  }

  /**
   * Occupied slots for a batch of plans, in ONE transaction — the exact
   * same two-source sum `CapacityService.occupiedSlots` computes for a
   * single plan (servers on the plan, plus commercial-site subscriptions
   * not yet attached to a server), just batched with `groupBy` across
   * every plan the catalog is about to render, the same duplication
   * `CapacityReportService.planUsage` already makes for the identical
   * reason (see that method's own doc comment). This runs under an
   * ADMIN RLS context — a public catalog request has no `userId` to
   * scope to, and counting occupancy across every customer's
   * subscriptions/servers is inherently a cross-tenant aggregate, the
   * same posture `PlansService.remove`'s in-use check already takes.
   * Nothing customer-identifying leaves this method, only counts.
   */
  private async occupancyForPlans(planIds: string[]): Promise<Map<string, number>> {
    if (planIds.length === 0) return new Map();
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const [serverCounts, subscriptionCounts] = await Promise.all([
        tx.server.groupBy({ by: ['planId'], where: { planId: { in: planIds }, status: { not: 'deleting' } }, _count: { _all: true } }),
        tx.subscription.groupBy({
          by: ['planId'],
          where: { planId: { in: planIds }, serverId: null, status: { in: [...SLOT_HOLDING_SUBSCRIPTION_STATUSES] } },
          _count: { _all: true },
        }),
      ]);
      const map = new Map<string, number>();
      for (const c of serverCounts) map.set(c.planId as string, (map.get(c.planId as string) ?? 0) + c._count._all);
      for (const c of subscriptionCounts) map.set(c.planId as string, (map.get(c.planId as string) ?? 0) + c._count._all);
      return map;
    });
  }

  /**
   * Availability is computed here, ONCE, and never by the frontend (the
   * commercial plan's own rule: "não permitir que o frontend determine
   * sozinho se existe capacidade") — but purely from `maxSlots` vs.
   * `occupied`, the exact accounting `SubscriptionsService
   * .createForUser` enforces under lock at subscribe time, so the
   * number shown here and the number that actually gates a subscribe
   * request can never disagree.
   *
   * An earlier version also folded in `NodeSchedulerService.selectNode`
   * — "no eligible node right now" also read as sold out. Found live,
   * against a fresh dev database with plans but zero nodes bootstrapped
   * yet: EVERY plan showed "Esgotado," including ones with no slot
   * limit at all. That conflates two different things — "this plan is
   * commercially full" vs. "nobody has provisioned a node for it yet" —
   * and this milestone deliberately never provisions a server at
   * subscribe time anyway (see the commercial plan's §13: a `pending`
   * subscription sits waiting on an admin regardless of node state).
   * Gating the storefront on live infrastructure would misrepresent a
   * plan as sold out when it is really just not deployed yet, and
   * blocks a legitimate `pending` subscription for no reason tied to
   * actual commercial stock. Node fit belongs to the (future, not-yet-
   * built) auto-provisioning flow, not to what a visitor sees here.
   */
  private computeAvailability(maxSlots: number | null, occupied: number): PlanAvailability {
    if (maxSlots === null) return { status: 'available', remaining: null };
    const remaining = maxSlots - occupied;
    if (remaining <= 0) return { status: 'sold_out', remaining: 0 };
    return { status: remaining <= LOW_STOCK_THRESHOLD ? 'limited' : 'available', remaining };
  }

  /** Strips `maxSlots` (internal-only, see PLAN_PUBLIC_SELECT's own doc comment) and attaches the computed `availability` in its place. */
  private toPublicPlan(plan: PlanRow, availability: PlanAvailability) {
    const { maxSlots: _maxSlots, ...publicFields } = plan;
    return { ...publicFields, availability };
  }
}
