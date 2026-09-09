import { Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { WebhookProcessingQueueService } from './webhook-processing-queue.service';
import { Public } from '../auth/decorators/public.decorator';
import { PAYMENT_PROVIDER, type PaymentProvider, type WebhookRequestInput } from './payment-provider.interface';

/**
 * Asaas's own webhook — `@Public()`, same posture the Mercado Pago
 * route took: no user JWT, no admin guard. The request's own
 * `asaas-access-token` header (verified by `provider.parseWebhook`
 * BEFORE anything in the body is trusted) is this route's entire
 * authentication.
 *
 * Deliberately no `@Body()` DTO — Asaas's payload shape varies by event
 * (`payment` vs `subscription` vs others this platform doesn't handle)
 * and a strict DTO with `forbidNonWhitelisted: true` (main.ts's global
 * ValidationPipe) would reject some of them outright. `req.body` is
 * read raw instead.
 *
 * Does the ABSOLUTE MINIMUM synchronously — verify, dedupe-insert,
 * enqueue — then responds 200. Everything else
 * (`PaymentsWebhookService.process`) happens in the `webhook-processing`
 * queue. This split exists specifically because Asaas's own docs say a
 * webhook endpoint returning non-2xx 15 times in a row gets its ENTIRE
 * sync queue interrupted (new events keep generating but stop being
 * delivered until manually resumed) — a slow database query or a
 * transient re-fetch failure must never cost this deployment one of
 * those 15 strikes.
 */
@Controller('api/webhooks/asaas')
@Public()
export class PaymentsWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookProcessingQueueService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: FastifyRequest) {
    const input: WebhookRequestInput = {
      headers: req.headers as WebhookRequestInput['headers'],
      query: req.query as WebhookRequestInput['query'],
      body: req.body,
    };
    // Throws (401) on an invalid/missing token — this is the ONLY
    // authentication this route has, so it must happen before the
    // dedupe-insert (never record, let alone queue, an unverified body).
    const parsed = this.provider.parseWebhook(input);

    try {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          id: parsed.notificationId,
          provider: this.provider.name,
          type: parsed.rawEvent,
          dataId: parsed.paymentExternalId ?? parsed.subscriptionExternalId,
          raw: (req.body ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Already received (and already enqueued, or already processed)
        // — a redelivery of the SAME notification id. Still 200: this is
        // success from Asaas's point of view, not a failure to retry.
        return { received: true };
      }
      throw err;
    }

    await this.queue.enqueue(parsed);
    return { received: true };
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}
