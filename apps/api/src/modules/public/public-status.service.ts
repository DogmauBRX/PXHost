import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { SiteAnnouncementService, type PublicAnnouncement } from '../site-announcement/site-announcement.service';

export type LocationStatusLevel = 'operational' | 'degraded' | 'maintenance' | 'offline';

export interface PublicLocationStatus {
  id: string;
  name: string;
  shortCode: string;
  country: string | null;
  status: LocationStatusLevel;
  // The nearest FUTURE `Node.maintenanceScheduledAt` among this
  // location's public nodes, or `null`. Only ever populated when
  // `status !== 'maintenance'` — once a node is actually IN maintenance,
  // "entra em manutenção em X" would be a confusing, already-stale
  // thing to say (see `aggregateSchedule`'s own doc comment).
  nextMaintenanceAt: string | null;
}

const CACHE_KEY = 'public:node-status:v1';
const CACHE_TTL_SECONDS = 30; // same window public-plans.service.ts uses for its own catalog read

/**
 * What a customer sees of node health — never a raw node name/fqdn/
 * hostname (that stays admin-only, `NodesService`/`CapacityReportService`),
 * aggregated to per-LOCATION so "which physical machine" is never
 * exposed either. `Node.isPublic` gates membership here the same way it
 * already gates `NodeSchedulerService`'s candidate pool — a node an
 * admin marked private has no business appearing in a customer-facing
 * status page. A location with zero eligible nodes is omitted entirely
 * rather than shown as some fabricated status: never surface a location
 * this deployment doesn't actually have public infrastructure in.
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

  async getNodeStatus(): Promise<PublicLocationStatus[]> {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached) return JSON.parse(cached);

    const locations = await this.prisma.location.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        shortCode: true,
        country: true,
        nodes: {
          where: { deletedAt: null, isPublic: true },
          select: { maintenanceMode: true, lastHeartbeatAt: true, maintenanceScheduledAt: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const result: PublicLocationStatus[] = locations
      .filter((l) => l.nodes.length > 0)
      .map((l) => {
        const status = this.aggregateStatus(l.nodes);
        return {
          id: l.id,
          name: l.name,
          shortCode: l.shortCode,
          country: l.country,
          status,
          nextMaintenanceAt: status === 'maintenance' ? null : this.aggregateSchedule(l.nodes),
        };
      });

    await this.redis.client.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }

  /**
   * `maintenanceMode` wins outright — an admin deliberately taking a
   * node down for work is a different signal from an unplanned outage,
   * and a customer should be told which one it is. Otherwise derived
   * purely from heartbeat freshness (`deriveHealthStatus`, the same
   * function the admin dashboard uses — one definition of "online,"
   * never a second one for the public page). `unknown` (never
   * heartbeated) is treated as `degraded`, not `operational` — a node
   * this deployment can't currently vouch for should never read as a
   * clean green light.
   */
  private aggregateStatus(nodes: { maintenanceMode: boolean; lastHeartbeatAt: Date | null }[]): LocationStatusLevel {
    if (nodes.some((n) => n.maintenanceMode)) return 'maintenance';
    const healths = nodes.map((n) => deriveHealthStatus(n.lastHeartbeatAt));
    if (healths.every((h) => h === 'offline')) return 'offline';
    if (healths.some((h) => h !== 'online')) return 'degraded';
    return 'operational';
  }

  /**
   * The EARLIEST future `maintenanceScheduledAt` among this location's
   * nodes — a past value (an admin who set a date and never cleared it
   * once the window passed) is silently ignored rather than shown as a
   * stale "entra em manutenção" that already happened. Only called when
   * the location isn't already `'maintenance'` (see the caller).
   */
  private aggregateSchedule(nodes: { maintenanceScheduledAt: Date | null }[]): string | null {
    const now = Date.now();
    const upcoming = nodes.map((n) => n.maintenanceScheduledAt).filter((d): d is Date => d !== null && d.getTime() > now);
    if (upcoming.length === 0) return null;
    return new Date(Math.min(...upcoming.map((d) => d.getTime()))).toISOString();
  }
}
