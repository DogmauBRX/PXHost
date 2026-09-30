import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import type { ModerateTestimonialDto, SubmitTestimonialDto } from './dto/testimonial.dto';

const CACHE_KEY = 'public:testimonials:v1';
// Same order of magnitude as the public plans catalog — this is curated,
// admin-picked content, not something that needs to reflect a moderation
// action within seconds.
const CACHE_TTL_SECONDS = 30;

export interface PublicTestimonial {
  id: string;
  authorName: string;
  rating: number;
  message: string;
}

@Injectable()
export class TestimonialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /**
   * "Has a real, paid, hosted server" (either now or in the past) is
   * proxied by a Subscription row that actually got attached to one —
   * `serverId` is only ever set once ProvisioningService confirms payment
   * (see Subscription.serverId's own doc comment), never for a 'pending'
   * subscription that was abandoned before paying. Deliberately not
   * scoped to `status: 'active'` — an ex-customer's honest depoimento is
   * exactly the kind of content this feature wants, not just current ones.
   */
  private async isEligible(userId: string): Promise<boolean> {
    const subscription = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subscription.findFirst({ where: { userId, serverId: { not: null } }, select: { id: true } }),
    );
    return subscription !== null;
  }

  /**
   * Upsert by userId: editing an existing testimonial always resets it to
   * 'pending' and un-features it, so a customer can never silently change
   * already-published, admin-approved public content — every edit goes
   * back through moderation, even if the words end up identical.
   */
  async submit(actor: { id: string }, dto: SubmitTestimonialDto) {
    if (!(await this.isEligible(actor.id))) {
      throw new ConflictException('Depoimentos são exclusivos para clientes que já tiveram um servidor contratado.');
    }
    const user = await this.prisma.withRLS({ userId: actor.id, isAdmin: false }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { firstName: true, lastName: true, username: true } }),
    );
    const authorName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username;

    const testimonial = await this.prisma.withRLS({ userId: actor.id, isAdmin: false }, (tx) =>
      tx.testimonial.upsert({
        where: { userId: actor.id },
        update: { authorName, rating: dto.rating, message: dto.message, status: 'pending', featured: false, featuredOrder: null, moderatedBy: null, moderatedAt: null },
        create: { userId: actor.id, authorName, rating: dto.rating, message: dto.message },
      }),
    );
    await this.redis.client.del(CACHE_KEY).catch(() => undefined);
    return testimonial;
  }

  async mine(actor: { id: string }) {
    return this.prisma.withRLS({ userId: actor.id, isAdmin: false }, (tx) => tx.testimonial.findUnique({ where: { userId: actor.id } }));
  }

  async checkEligibility(actor: { id: string }) {
    return { eligible: await this.isEligible(actor.id) };
  }

  async listForAdmin(status?: 'pending' | 'approved' | 'rejected') {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.testimonial.findMany({ where: status ? { status } : undefined, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] }),
    );
  }

  async moderate(id: string, dto: ModerateTestimonialDto, actorId: string) {
    const before = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.testimonial.findUniqueOrThrow({ where: { id } }));

    const nextStatus = dto.status ?? before.status;
    // Only ever-approved content can be featured; a rejected/pending
    // testimonial must never appear on the public site regardless of what
    // an admin later sets `featured` to in the same request.
    if (dto.featured && nextStatus !== 'approved') {
      throw new BadRequestException('Só é possível destacar um depoimento aprovado.');
    }
    // Leaving 'approved' un-features automatically — a featured
    // testimonial that gets rejected later must disappear from the public
    // site, not linger because the admin only touched `status`.
    const nextFeatured = nextStatus === 'approved' ? (dto.featured ?? before.featured) : false;

    const updated = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.testimonial.update({
        where: { id },
        data: {
          status: nextStatus,
          featured: nextFeatured,
          featuredOrder: nextFeatured ? (dto.featuredOrder ?? before.featuredOrder) : null,
          moderatedBy: actorId,
          moderatedAt: new Date(),
        },
      }),
    );
    await this.redis.client.del(CACHE_KEY).catch(() => undefined);

    await this.audit.record({
      action: 'admin.testimonial.moderate',
      actorId,
      targetType: 'testimonial',
      targetId: id,
      beforeState: { status: before.status, featured: before.featured, featuredOrder: before.featuredOrder },
      afterState: { status: updated.status, featured: updated.featured, featuredOrder: updated.featuredOrder },
    });
    return updated;
  }

  async listPublicFeatured(): Promise<PublicTestimonial[]> {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached !== null) return JSON.parse(cached);

    const rows = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.testimonial.findMany({
        where: { status: 'approved', featured: true },
        orderBy: [{ featuredOrder: 'asc' }, { moderatedAt: 'desc' }],
        select: { id: true, authorName: true, rating: true, message: true },
      }),
    );
    await this.redis.client.set(CACHE_KEY, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return rows;
  }
}
