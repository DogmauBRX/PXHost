import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MercadoPagoClient } from './mercadopago.client';
import { amountToCents, centsToAmount } from './money';
import { PaymentProviderRequestError } from './payment-provider.interface';
import type {
  CreateCardSubscriptionInput,
  CreatePixChargeInput,
  GatewayPayment,
  GatewaySubscription,
  InternalPaymentEvent,
  ParsedWebhook,
  PaymentProvider,
  PixCharge,
  RefundResult,
  WebhookRequestInput,
  WebhookResourceKind,
} from './payment-provider.interface';

/**
 * Mercado Pago's own payment vocabulary (`GET /v1/payments/{id}`'s
 * `status`) → this platform's outcome vocabulary. Every status NOT
 * listed maps to `'Ignored'` — a deliberate, closed mapping, never a
 * silent fallthrough.
 */
const PAYMENT_STATUS_MAP: Record<string, InternalPaymentEvent> = {
  approved: 'PaymentConfirmed',
  pending: 'PaymentPending',
  in_process: 'PaymentPending',
  authorized: 'PaymentPending',
  rejected: 'PaymentFailed',
  cancelled: 'PaymentCanceled',
  refunded: 'PaymentRefunded',
  charged_back: 'PaymentChargeback',
  in_mediation: 'PaymentChargeback',
};

/**
 * Preapproval (`GET /preapproval/{id}`) statuses. Note what is NOT here:
 * `authorized` does not map to any Payment* outcome. The customer
 * authorizing recurring charges is not the customer having paid — the
 * money only counts when a `payment`/`subscription_authorized_payment`
 * notification produces `PaymentConfirmed`.
 */
const PREAPPROVAL_STATUS_MAP: Record<string, InternalPaymentEvent> = {
  authorized: 'SubscriptionSynced',
  pending: 'SubscriptionSynced',
  paused: 'SubscriptionCanceled',
  cancelled: 'SubscriptionCanceled',
};

/** Mercado Pago's notification topics → which resource to re-fetch. Any other topic is acknowledged and ignored. */
const TOPIC_RESOURCE: Record<string, WebhookResourceKind> = {
  payment: 'payment',
  subscription_preapproval: 'preapproval',
  subscription_authorized_payment: 'authorized_payment',
};

/** This platform's billing periods → Mercado Pago's `auto_recurring` shape. */
const RECURRENCE: Record<CreateCardSubscriptionInput['billingPeriod'], { frequency: number; frequency_type: 'months' }> = {
  monthly: { frequency: 1, frequency_type: 'months' },
  quarterly: { frequency: 3, frequency_type: 'months' },
  semiannual: { frequency: 6, frequency_type: 'months' },
  annual: { frequency: 12, frequency_type: 'months' },
};

interface MpPayment {
  id: number | string;
  status: string;
  status_detail: string | null;
  external_reference: string | null;
  transaction_amount: number | null;
  transaction_details?: { total_paid_amount?: number | null } | null;
  currency_id: string | null;
  payment_method_id: string | null;
  payment_type_id: string | null;
  installments: number | null;
  date_approved: string | null;
  metadata?: Record<string, unknown> | null;
  point_of_interaction?: {
    transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } | null;
  } | null;
  date_of_expiration?: string | null;
}

/** `GET /authorized_payments/{id}` — one recurring charge of a preapproval. */
interface MpAuthorizedPayment {
  id: number | string;
  preapproval_id: string | null;
  external_reference?: string | null;
  status: string | null;
  transaction_amount: number | null;
  currency_id: string | null;
  date_created: string | null;
  payment?: { id: number | string; status: string | null; status_detail?: string | null } | null;
}

interface MpPreapproval {
  id: string;
  status: string;
  external_reference: string | null;
  init_point: string | null;
  next_payment_date: string | null;
  auto_recurring?: { transaction_amount?: number | null; currency_id?: string | null } | null;
}

interface MpRefund {
  id: number | string;
  status: string | null;
  amount: number | null;
}

interface MpWebhookBody {
  id?: number | string;
  type?: string;
  topic?: string;
  action?: string;
  data?: { id?: number | string };
}

/**
 * The ONLY class that knows Mercado Pago's own request/response shapes —
 * everything else in the platform depends on `PaymentProvider`, never on
 * this. See that interface's own header for the input-vocabulary-vs-
 * output-vocabulary split this class maintains.
 *
 * Two Mercado Pago products are used, one per payment method, because
 * Mercado Pago has no single product that covers both:
 *  - **Pix** → `POST /v1/payments`, one charge per billing cycle. There
 *    is no recurring Pix at Mercado Pago; `BillingCycleProcessor`
 *    generates the next cycle's charge.
 *  - **Card** → `POST /preapproval`, a real recurring subscription that
 *    Mercado Pago itself schedules and charges.
 */
@Injectable()
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';

  constructor(
    private readonly client: MercadoPagoClient,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN'));
  }

  async createPixCharge(input: CreatePixChargeInput): Promise<PixCharge> {
    const payment = await this.client.post<MpPayment>(
      '/v1/payments',
      {
        transaction_amount: centsToAmount(input.amountCents),
        description: input.description,
        payment_method_id: 'pix',
        external_reference: input.externalReference,
        notification_url: this.notificationUrl(),
        date_of_expiration: input.expiresAt.toISOString(),
        payer: {
          email: input.payer.email,
          first_name: input.payer.firstName ?? undefined,
          last_name: input.payer.lastName ?? undefined,
          identification: { type: 'CPF', number: input.payer.cpf },
          address: {
            zip_code: input.payer.address.postalCode,
            street_name: input.payer.address.addressLine,
            street_number: input.payer.address.addressNumber,
            neighborhood: input.payer.address.neighborhood,
            city: input.payer.address.city,
            federal_unit: input.payer.address.state,
          },
        },
      },
      input.idempotencyKey,
    );

    const qr = payment.point_of_interaction?.transaction_data;
    if (!qr?.qr_code || !qr.qr_code_base64) {
      // Never hand the customer a "Pix created" screen with no way to
      // actually pay it — fail the checkout loudly instead.
      throw new PaymentProviderRequestError('Mercado Pago returned a Pix payment with no QR code', 502);
    }

    return {
      ...toGatewayPayment(payment),
      qrCode: qr.qr_code,
      qrCodeBase64: qr.qr_code_base64,
      expiresAt: payment.date_of_expiration ? new Date(payment.date_of_expiration) : null,
    };
  }

  async createCardSubscription(input: CreateCardSubscriptionInput): Promise<GatewaySubscription> {
    const recurrence = RECURRENCE[input.billingPeriod];
    const preapproval = await this.client.post<MpPreapproval>(
      '/preapproval',
      {
        reason: input.description,
        external_reference: input.externalReference,
        payer_email: input.payer.email,
        back_url: input.backUrl,
        auto_recurring: {
          frequency: recurrence.frequency,
          frequency_type: recurrence.frequency_type,
          transaction_amount: centsToAmount(input.amountCents),
          currency_id: input.currency,
        },
      },
      input.idempotencyKey,
    );
    return toGatewaySubscription(preapproval);
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    const payment = await this.client.get<MpPayment>(`/v1/payments/${externalId}`);
    return toGatewayPayment(payment);
  }

  /**
   * A recurring charge of a card subscription. Normalized into the same
   * `GatewayPayment` shape as a standalone payment so the webhook
   * pipeline has exactly one payment model to reason about — the
   * `preapproval_id` it carries is what links it back to this
   * platform's own `Subscription`.
   */
  async getAuthorizedPayment(externalId: string): Promise<GatewayPayment> {
    const authorized = await this.client.get<MpAuthorizedPayment>(`/authorized_payments/${externalId}`);
    // The authorized_payment wraps the real payment; its own `status`
    // ('processed'/'recycling'/'scheduled') describes the RETRY cycle,
    // not the money, so the inner payment's status wins whenever present.
    const status = authorized.payment?.status ?? mapAuthorizedPaymentStatus(authorized.status);
    return {
      id: String(authorized.payment?.id ?? authorized.id),
      status: status ?? 'pending',
      statusDetail: authorized.payment?.status_detail ?? null,
      subscriptionExternalId: authorized.preapproval_id ?? null,
      externalReference: authorized.external_reference ?? null,
      amountCents: authorized.transaction_amount != null ? amountToCents(authorized.transaction_amount) : null,
      paidAmountCents: null,
      currency: authorized.currency_id ?? null,
      paymentMethodId: 'credit_card',
      paymentTypeId: 'credit_card',
      installments: null,
      approvedAt: status === 'approved' && authorized.date_created ? new Date(authorized.date_created) : null,
      raw: authorized,
    };
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    const preapproval = await this.client.get<MpPreapproval>(`/preapproval/${externalId}`);
    return toGatewaySubscription(preapproval);
  }

  /**
   * A 404 here means Mercado Pago has no record of this preapproval at
   * all — the caller's desired end state (no further billing at the
   * provider) is already true, so this is NOT a failure to cancel.
   * Every other status still propagates: this must never silently
   * swallow a real failure and let the customer believe they cancelled
   * when they didn't.
   */
  async cancelSubscription(externalId: string): Promise<void> {
    try {
      await this.client.put(`/preapproval/${externalId}`, { status: 'cancelled' });
    } catch (err) {
      if (err instanceof PaymentProviderRequestError && err.status === 404) return;
      throw err;
    }
  }

  /** Body omitted entirely = full refund; `{ amount }` = partial. Mercado Pago requires `X-Idempotency-Key` on this endpoint specifically, so a retry can never double-refund. */
  async refund(externalId: string, amountCents?: number): Promise<RefundResult> {
    const body = amountCents !== undefined ? { amount: centsToAmount(amountCents) } : {};
    const refund = await this.client.post<MpRefund>(`/v1/payments/${externalId}/refunds`, body, `refund-${externalId}-${amountCents ?? 'full'}`);
    return {
      id: String(refund.id),
      status: refund.status ?? null,
      amountCents: refund.amount != null ? amountToCents(refund.amount) : null,
    };
  }

  classifyPayment(payment: GatewayPayment): InternalPaymentEvent {
    return classifyMercadoPagoPayment(payment.status);
  }

  classifySubscription(subscription: GatewaySubscription): InternalPaymentEvent {
    return classifyMercadoPagoPreapproval(subscription.status);
  }

  /**
   * Mercado Pago signs every notification with HMAC-SHA256 over a
   * manifest built from the resource id, the `x-request-id` header and
   * the signature's own timestamp:
   *
   *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
   *
   * verbatim from their docs, with two rules that are easy to get wrong
   * and both implemented below: a `data.id` containing uppercase
   * characters is lowercased first, and a segment whose value is absent
   * is REMOVED from the manifest entirely rather than left empty.
   *
   * The secret is the application's own webhook secret from the Mercado
   * Pago dashboard — NOT the access token, a different value entirely.
   * Unset means this deployment never configured webhooks, and an
   * unverifiable notification is refused rather than trusted.
   */
  parseWebhook(req: WebhookRequestInput): ParsedWebhook {
    const secret = this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET');
    if (!secret) {
      throw new UnauthorizedException('Mercado Pago webhooks are not configured on this deployment');
    }

    const body = (req.body ?? {}) as MpWebhookBody;
    // Mercado Pago puts `data.id` in the QUERY STRING of the
    // notification and repeats it in the body; the query is what their
    // own validation example reads, so it wins here.
    const dataId = firstString(req.query['data.id']) ?? (body.data?.id != null ? String(body.data.id) : null);
    const requestId = firstString(req.headers['x-request-id']);
    const { ts, v1 } = parseSignatureHeader(firstString(req.headers['x-signature']));

    if (!ts || !v1) {
      throw new UnauthorizedException('Missing or malformed x-signature header');
    }

    let manifest = '';
    if (dataId) manifest += `id:${lowercaseIfNeeded(dataId)};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${ts};`;

    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    if (!constantTimeEquals(expected, v1)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const topic = body.type ?? body.topic ?? firstString(req.query.type) ?? firstString(req.query.topic) ?? '';
    const action = body.action ?? '';
    return {
      notificationId: body.id != null ? String(body.id) : `${topic}-${dataId ?? 'unknown'}-${ts}`,
      rawEvent: action || topic,
      resourceKind: TOPIC_RESOURCE[topic] ?? null,
      resourceId: dataId,
    };
  }

  /** Where Mercado Pago sends notifications for charges this platform creates. Falls back to the public site origin so a deployment that only set `PUBLIC_SITE_URL` still works. */
  private notificationUrl(): string | undefined {
    const explicit = this.config.get<string>('MERCADOPAGO_NOTIFICATION_URL');
    if (explicit) return explicit;
    const base = this.config.get<string>('PUBLIC_SITE_URL');
    return base ? `${base.replace(/\/$/, '')}/api/webhooks/mercadopago` : undefined;
  }
}

/**
 * Exported as standalone functions, not just methods, so the e2e
 * suite's fake provider can classify with the EXACT same mapping the
 * real one uses — a fake that invented its own status vocabulary would
 * let the tests agree with themselves while disagreeing with
 * production.
 */
export function classifyMercadoPagoPayment(status: string): InternalPaymentEvent {
  return PAYMENT_STATUS_MAP[status] ?? 'Ignored';
}

export function classifyMercadoPagoPreapproval(status: string): InternalPaymentEvent {
  return PREAPPROVAL_STATUS_MAP[status] ?? 'Ignored';
}

function toGatewayPayment(payment: MpPayment): GatewayPayment {
  return {
    id: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail ?? null,
    // A standalone Pix charge belongs to no preapproval — it is matched
    // back to its order by `external_reference` instead.
    subscriptionExternalId: null,
    externalReference: payment.external_reference ?? null,
    amountCents: payment.transaction_amount != null ? amountToCents(payment.transaction_amount) : null,
    paidAmountCents: payment.transaction_details?.total_paid_amount != null ? amountToCents(payment.transaction_details.total_paid_amount) : null,
    currency: payment.currency_id ?? null,
    paymentMethodId: payment.payment_method_id ?? null,
    paymentTypeId: payment.payment_type_id ?? null,
    installments: payment.installments ?? null,
    approvedAt: payment.date_approved ? new Date(payment.date_approved) : null,
    raw: payment,
  };
}

function toGatewaySubscription(preapproval: MpPreapproval): GatewaySubscription {
  return {
    id: preapproval.id,
    status: preapproval.status,
    externalReference: preapproval.external_reference ?? null,
    nextDueDate: preapproval.next_payment_date ? new Date(preapproval.next_payment_date) : null,
    initPoint: preapproval.init_point ?? null,
    raw: preapproval,
  };
}

/** `authorized_payments` describes the RETRY cycle, not the money — only a terminal one tells us anything about the charge itself. */
function mapAuthorizedPaymentStatus(status: string | null): string | null {
  if (status === 'processed') return 'approved';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

/** `ts=1704908010,v1=<hex>` — order is not guaranteed, so both parts are parsed by name. */
function parseSignatureHeader(header: string | null): { ts: string | null; v1: string | null } {
  if (!header) return { ts: null, v1: null };
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey?.trim();
    const value = rest.join('=').trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  return { ts, v1 };
}

/** Mercado Pago's docs: "If `data.id` is returned with uppercase alphanumeric characters, convert it to lowercase before using it in the manifest." */
function lowercaseIfNeeded(dataId: string): string {
  return /[A-Z]/.test(dataId) ? dataId.toLowerCase() : dataId;
}

function firstString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** A hex digest compared with `===` would leak its prefix through response timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
