import { Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { WebhookProcessingQueueService } from './webhook-processing-queue.service';
import { Public } from '../auth/decorators/public.decorator';
import { PAYMENT_PROVIDER, type PaymentProvider, type WebhookRequestInput } from './payment-provider.interface';

/**
 * Mercado Pago's webhook — `@Public()`: no user JWT, no admin guard.
 * The request's own `x-signature` HMAC (verified by
 * `provider.parseWebhook` BEFORE anything in the body is trusted) is
 * this route's entire authentication.
 *
 * Deliberately no `@Body()` DTO — the payload shape varies by topic
 * (`payment` vs `subscription_preapproval` vs others this platform
 * doesn't handle) and a strict DTO with `forbidNonWhitelisted: true`
 * (main.ts's global ValidationPipe) would reject some of them outright.
 * `req.body` is read raw instead, and the signature covers the resource
 * id regardless.
 *
 * Does the ABSOLUTE MINIMUM synchronously — verify, dedupe-insert,
 * enqueue — then responds 200. Everything else
 * (`PaymentsWebhookService.process`) happens in the `webhook-processing`
 * queue, so a slow database query or a transient re-fetch failure never
 * turns into a non-2xx that makes Mercado Pago retry a notification it
 * already delivered successfully.
 */
@Controller('api/webhooks/mercadopago')
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
    // Throws (401) on an invalid/missing signature — this is the ONLY
    // authentication this route has, so it must happen before the
    // dedupe-insert (never record, let alone queue, an unverified body).
    const parsed = await this.provider.parseWebhook(input);

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
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Already received (and already enqueued, or already processed)
        // — a redelivery of the SAME notification id. Still 200: this is
        // success from Mercado Pago's point of view, not a failure to
        // retry.
        return { received: true };
      }
      throw err;
    }

    await this.queue.enqueue(this.provider.name, parsed);
    return { received: true };
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}
