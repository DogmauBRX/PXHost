import { BadRequestException, ConflictException } from '@nestjs/common';
import { TestimonialsService } from './testimonials.service';

describe('TestimonialsService', () => {
  const actor = { id: 'user-1' };
  const redis = { client: { get: jest.fn(async (): Promise<string | null> => null), set: jest.fn(async () => undefined), del: jest.fn(async () => undefined) } };
  const audit = { record: jest.fn(async () => undefined) };

  beforeEach(() => jest.clearAllMocks());

  function createService(opts: { subscription?: { id: string } | null; user?: Record<string, unknown>; testimonial?: Record<string, unknown> } = {}) {
    const testimonialRow = { id: 'test-1', userId: actor.id, status: 'pending', featured: false, featuredOrder: null, ...opts.testimonial };
    const testimonial = {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => ({ ...testimonialRow, ...args.create })),
      findUnique: jest.fn(async () => testimonialRow),
      findUniqueOrThrow: jest.fn(async () => testimonialRow),
      findMany: jest.fn(async () => [testimonialRow]),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ ...testimonialRow, ...args.data })),
    };
    const tx = {
      subscription: { findFirst: jest.fn(async () => (opts.subscription === undefined ? { id: 'sub-1' } : opts.subscription)) },
      user: { findUniqueOrThrow: jest.fn(async () => ({ firstName: null, lastName: null, username: 'jogador123', ...opts.user })) },
      testimonial,
    };
    const prisma = { withRLS: jest.fn(async (_ctx: unknown, op: (client: typeof tx) => Promise<unknown>) => op(tx)) };
    const service = new TestimonialsService(prisma as never, redis as never, audit as never);
    return { service, testimonial, tx };
  }

  describe('submit', () => {
    it('rejects a customer who never had a provisioned server', async () => {
      const { service } = createService({ subscription: null });
      await expect(service.submit(actor, { rating: 5, message: 'Ótimo serviço, recomendo!' })).rejects.toThrow(ConflictException);
    });

    it('uses first+last name when available', async () => {
      const { service, testimonial } = createService({ user: { firstName: 'Ana', lastName: 'Silva' } });
      await service.submit(actor, { rating: 5, message: 'Ótimo serviço, recomendo!' });
      expect(testimonial.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ authorName: 'Ana Silva' }) }));
    });

    it('falls back to the username when no name is set', async () => {
      const { service, testimonial } = createService();
      await service.submit(actor, { rating: 4, message: 'Suporte rápido e atencioso!' });
      expect(testimonial.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ authorName: 'jogador123' }) }));
    });

    it('resets an edited testimonial back to pending and un-featured', async () => {
      const { service, testimonial } = createService();
      await service.submit(actor, { rating: 3, message: 'Editando meu depoimento antigo.' });
      expect(testimonial.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({ status: 'pending', featured: false, featuredOrder: null }),
      }));
    });
  });

  describe('moderate', () => {
    it('refuses to feature a testimonial that is not approved', async () => {
      const { service } = createService({ testimonial: { status: 'pending' } });
      await expect(service.moderate('test-1', { featured: true }, 'admin-1')).rejects.toThrow(BadRequestException);
    });

    it('allows featuring in the same request that approves it', async () => {
      const { service, testimonial } = createService({ testimonial: { status: 'pending' } });
      await service.moderate('test-1', { status: 'approved', featured: true, featuredOrder: 2 }, 'admin-1');
      expect(testimonial.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'approved', featured: true, featuredOrder: 2 }),
      }));
    });

    it('automatically un-features a testimonial moved away from approved', async () => {
      const { service, testimonial } = createService({ testimonial: { status: 'approved', featured: true, featuredOrder: 1 } });
      await service.moderate('test-1', { status: 'rejected' }, 'admin-1');
      expect(testimonial.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected', featured: false, featuredOrder: null }),
      }));
    });

    it('records an audit entry with before/after state', async () => {
      const { service } = createService({ testimonial: { status: 'pending' } });
      await service.moderate('test-1', { status: 'approved' }, 'admin-1');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin.testimonial.moderate',
        actorId: 'admin-1',
        targetId: 'test-1',
      }));
    });
  });

  describe('listPublicFeatured', () => {
    it('serves from cache when present, without querying the database', async () => {
      redis.client.get.mockResolvedValueOnce(JSON.stringify([{ id: 'cached', authorName: 'X', rating: 5, message: 'Y' }]));
      const { service, tx } = createService();
      const result = await service.listPublicFeatured();
      expect(result).toEqual([{ id: 'cached', authorName: 'X', rating: 5, message: 'Y' }]);
      expect(tx.testimonial.findMany).not.toHaveBeenCalled();
    });

    it('queries approved+featured only and caches the result', async () => {
      const { service, tx } = createService();
      await service.listPublicFeatured();
      expect(tx.testimonial.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'approved', featured: true } }));
      expect(redis.client.set).toHaveBeenCalled();
    });
  });
});
