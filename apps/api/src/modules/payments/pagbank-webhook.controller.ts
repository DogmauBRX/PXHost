import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../core/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { PagBankProvider } from './pagbank.provider';
import type { WebhookRequestInput } from './payment-provider.interface';
import { WebhookProcessingQueueService } from './webhook-processing-queue.service';

@Controller('api/webhooks/pagbank')
@Public()
export class PagBankWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookProcessingQueueService,
    private readonly provider: PagBankProvider,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: FastifyRequest & { rawBody?: Buffer }) {
    const parsed = await this.provider.parseWebhook({
      headers: req.headers as WebhookRequestInput['headers'],
      query: req.query as WebhookRequestInput['query'],
      body: req.body,
      rawBody: req.rawBody,
    });

    try {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          id: parsed.notificationId,
          provider: this.provider.name,
          type: parsed.rawEvent,
          dataId: parsed.resourceId,
          raw: (req.body ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return { received: true };
      throw error;
    }

    await this.queue.enqueue(this.provider.name, parsed);
    return { received: true };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}
