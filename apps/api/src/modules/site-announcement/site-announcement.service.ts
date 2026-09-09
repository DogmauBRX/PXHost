import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { UpdateSiteAnnouncementDto } from './dto/update-site-announcement.dto';

const CACHE_KEY = 'public:announcement:v1';
// Short TTL, not the 30s public-plans/node-status use — an admin toggling
// this off (e.g. mid-incident) should reach every visitor fast, and a
// single-row read is cheap enough that a longer cache buys little.
const CACHE_TTL_SECONDS = 10;

export interface PublicAnnouncement {
  message: string;
  updatedAt: string;
}

/**
 * Site-wide announcement banner (schema.prisma's own doc comment on
 * `SiteAnnouncement` has the full picture) — single row, found or
 * created on first read/write rather than keyed on a magic fixed id,
 * the same posture prisma/seed.ts already uses for the root admin.
 */
@Injectable()
export class SiteAnnouncementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  private async getRow() {
    const existing = await this.prisma.siteAnnouncement.findFirst();
    if (existing) return existing;
    return this.prisma.siteAnnouncement.create({ data: {} });
  }

  async getForAdmin() {
    return this.getRow();
  }

  /** `null` whenever there's nothing to show — inactive OR an empty message — so the frontend's contract is simply "render if non-null," never a separate isActive check on top. */
  async getPublic(): Promise<PublicAnnouncement | null> {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached !== null) return cached === '' ? null : JSON.parse(cached);

    const row = await this.getRow();
    const result = row.isActive && row.message.trim() ? { message: row.message, updatedAt: row.updatedAt.toISOString() } : null;

    await this.redis.client.set(CACHE_KEY, result ? JSON.stringify(result) : '', 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }

  /**
   * Explicit field map + audit, same discipline `NodesService.update`
   * already applies to its own admin-editable columns — `metadata` is
   * an allow-list of exactly the two fields this DTO can touch, never a
   * spread of the raw DTO.
   */
  async update(dto: UpdateSiteAnnouncementDto, actorId: string) {
    const before = await this.getRow();

    const nextMessage = dto.message !== undefined ? dto.message.trim() : before.message;
    const nextActive = dto.isActive !== undefined ? dto.isActive : before.isActive;
    if (nextActive && !nextMessage) {
      throw new BadRequestException('message is required to activate the announcement');
    }

    const updated = await this.prisma.siteAnnouncement.update({
      where: { id: before.id },
      data: { message: nextMessage, isActive: nextActive, updatedBy: actorId },
    });

    await this.redis.client.del(CACHE_KEY).catch(() => undefined);

    await this.audit.record({
      action: 'admin.site_announcement.update',
      actorId,
      targetType: 'site_announcement',
      targetId: updated.id,
      beforeState: { message: before.message, isActive: before.isActive },
      afterState: { message: updated.message, isActive: updated.isActive },
    });

    return updated;
  }
}
