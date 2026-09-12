import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { SiteAnnouncementService, type PublicAnnouncement } from '../site-announcement/site-announcement.service';

export type PlatformStatusLevel = 'operational' | 'maintenance' | 'offline';

export interface PublicPlatformStatus {
  status: PlatformStatusLevel;
  // The nearest FUTURE `Node.maintenanceScheduledAt` across every public
  // node, or `null`. Only ever populated when `status !== 'maintenance'`
  // — once a node is actually IN maintenance, "entra em manutenção em X"
  // would be a confusing, already-stale thing to say (see
  // `aggregateSchedule`'s own doc comment).
  nextMaintenanceAt: string | null;
}

const CACHE_KEY = 'public:node-status:v1';
const CACHE_TTL_SECONDS = 30; // same window public-plans.service.ts uses for its own catalog read

/**
 * What a customer sees of node health — never a raw node name/fqdn/
 * hostname, never even which LOCATION (that granularity was tried and
 * dropped: with a single-digit node count, "por região" read as either
 * empty or as a one-card grid that just restated the overall status —
 * a visitor only ever needs "is the platform up", not a health matrix
 * per machine). `Node.isPublic` gates membership here the same way it
 * already gates `NodeSchedulerService`'s candidate pool — a node an
 * admin marked private has no business affecting a customer-facing
 * status page. Zero public nodes anywhere → `null`, so the frontend's
 * own "no infrastructure deployed yet" branch renders instead of a
 * fabricated status.
 */
@Injectable()
export class PublicStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly announcement: SiteAnnouncementService,
  ) {}

  getAnnouncement(): Promise<PublicAnnouncement | null> {
    return this.announcement.getPublic();
  }

  async getNodeStatus(): Promise<PublicPlatformStatus | null> {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached) return JSON.parse(cached);

    const nodes = await this.prisma.node.findMany({
      where: { deletedAt: null, isPublic: true, location: { deletedAt: null } },
      select: { maintenanceMode: true, lastHeartbeatAt: true, maintenanceScheduledAt: true },
    });

    let result: PublicPlatformStatus | null = null;
    if (nodes.length > 0) {
      const status = this.aggregateStatus(nodes);
      result = { status, nextMaintenanceAt: status === 'maintenance' ? null : this.aggregateSchedule(nodes) };
    }

    await this.redis.client.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }

  /**
   * Deliberately lenient: `operational` the moment ANY public node is
   * online, regardless of how many others are degraded/offline — the
   * platform owner's own call (2026-09-12), replacing an earlier
   * per-location rule where a single non-online node downgraded the
   * WHOLE location to `degraded`. With node counts this low, that
   * stricter rule read as "flaky" for what was in fact one machine
   * having a slow heartbeat while everything else served traffic fine.
   * `maintenanceMode` only surfaces once NOTHING is online — an admin
   * deliberately taking the only/last node down for work is a more
   * honest thing to say than a bare "offline" in that specific case.
   */
  private aggregateStatus(nodes: { maintenanceMode: boolean; lastHeartbeatAt: Date | null }[]): PlatformStatusLevel {
    const anyOnline = nodes.some((n) => deriveHealthStatus(n.lastHeartbeatAt) === 'online');
    if (anyOnline) return 'operational';
    if (nodes.some((n) => n.maintenanceMode)) return 'maintenance';
    return 'offline';
  }

  /**
   * The EARLIEST future `maintenanceScheduledAt` across every public
   * node — a past value (an admin who set a date and never cleared it
   * once the window passed) is silently ignored rather than shown as a
   * stale "entra em manutenção" that already happened. Only called when
   * the platform isn't already `'maintenance'` (see the caller).
   */
  private aggregateSchedule(nodes: { maintenanceScheduledAt: Date | null }[]): string | null {
    const now = Date.now();
    const upcoming = nodes.map((n) => n.maintenanceScheduledAt).filter((d): d is Date => d !== null && d.getTime() > now);
    if (upcoming.length === 0) return null;
    return new Date(Math.min(...upcoming.map((d) => d.getTime()))).toISOString();
  }
}
