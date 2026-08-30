import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingEventDto } from './dto/billing-event.dto';
import { Public } from '../auth/decorators/public.decorator';

/**
 * External payment provider webhook (architecture doc roadmap M14).
 * `@Public()` — no user JWT, no NodeAuthGuard: the request's OWN HMAC
 * signature (verified against the raw body by BillingWebhookService,
 * checked before the payload is trusted for anything) is this route's
 * entire authentication, the same posture a real Stripe/PayPal/etc
 * webhook endpoint always has, since the caller is a payment provider's
 * server, not a logged-in user or one of this platform's own agents.
 */
@Controller('api/billing/webhook')
@Public()
export class BillingController {
  constructor(private readonly webhook: BillingWebhookService) {}

  @Post()
  async receive(@Body() dto: BillingEventDto, @Headers('x-signature') signature: string | undefined, @Req() req: FastifyRequest) {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    this.webhook.verifySignature(rawBody ?? Buffer.alloc(0), signature);
    return this.webhook.handleEvent(dto);
  }
}
