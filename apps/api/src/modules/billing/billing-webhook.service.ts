import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ServersService } from '../servers/servers.service';

export interface BillingEventPayload {
  id: string;
  type: string;
  data: { serverId: string };
}

// A real processor's own event-type vocabulary varies; this is
// deliberately generic (architecture doc roadmap M14 names no specific
// provider) but shaped after the most common real-world convention
// (Stripe's own webhook event names) so adapting a real integration
// later is a mapping-table change, not a redesign.
const SUSPEND_EVENT_TYPES = new Set(['invoice.payment_failed', 'customer.subscription.deleted']);
const RESTORE_EVENT_TYPES = new Set(['invoice.payment_succeeded', 'customer.subscription.updated']);

/**
 * External payment webhook receiver (architecture doc roadmap M14:
 * "external payment event idempotently suspends/restores a server").
 *
 * Idempotency is the actual design center here, not an afterthought:
 * `billing_events.id` IS the provider's own event id (never a generated
 * uuid — see the migration's doc comment), so `create()` on an
 * already-seen id hits the primary key and throws Prisma's P2002, which
 * this service treats as "already processed, nothing to do" rather than
 * an error. A payment provider's own documented behavior is "the same
 * event MAY be delivered more than once" — this is not a hypothetical
 * edge case to defend against, it is the literal, expected contract of
 * every real webhook system, which is exactly why the DoD says
 * "idempotently."
 *
 * Signature verification happens BEFORE anything else touches the
 * payload — an HMAC-SHA256 of the raw request body, hex-encoded, in an
 * `X-Signature: sha256=<hex>` header, checked with a constant-time
 * comparison (a naive `===` here would leak the valid signature one byte
 * at a time to a timing attack, the exact same reasoning
 * `auth.VerifyNodeToken` on the agent side already documents).
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly servers: ServersService,
  ) {}

  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): void {
    const secret = this.config.get<string>('BILLING_WEBHOOK_SECRET');
    if (!secret) {
      // Fails closed: an unconfigured secret means this deployment never
      // opted into billing hooks at all, so refusing every event (rather
      // than silently trusting an unverifiable payload) is the only safe
      // default.
      throw new ServiceUnavailableException('Billing webhooks are not configured on this deployment');
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or malformed signature header');
    }
    const presented = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException('Signature verification failed');
    }
  }

  async handleEvent(payload: BillingEventPayload): Promise<{ processed: boolean; action: string | null }> {
    const action = SUSPEND_EVENT_TYPES.has(payload.type) ? 'suspend' : RESTORE_EVENT_TYPES.has(payload.type) ? 'restore' : null;
    if (!action) {
      // An event type this deployment doesn't act on (e.g. a provider
      // sends dozens of event types, most irrelevant here) is a
      // successful no-op, not an error — a webhook endpoint that 400s on
      // every type it doesn't recognize trains the provider to disable
      // the whole subscription after enough failures.
      this.logger.log(`billing event ${payload.id} (${payload.type}) — no action mapped, ignoring`);
      return { processed: false, action: null };
    }
    if (!payload.data?.serverId) {
      throw new BadRequestException('Event payload missing data.serverId');
    }

    try {
      await this.prisma.billingEvent.create({
        data: { id: payload.id, serverId: payload.data.serverId, type: payload.type, action, rawPayload: payload as unknown as object },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        this.logger.log(`billing event ${payload.id} already processed — idempotent no-op`);
        return { processed: false, action };
      }
      throw err;
    }

    if (action === 'suspend') {
      await this.servers.suspend(payload.data.serverId, `billing: ${payload.type}`, null);
    } else {
      await this.servers.unsuspend(payload.data.serverId, null);
    }
    return { processed: true, action };
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}
