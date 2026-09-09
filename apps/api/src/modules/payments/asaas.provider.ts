import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { AsaasClient } from './asaas.client';
import { amountToCents, centsToAmount } from './money';
import type {
  CreateSubscriptionInput,
  EnsureCustomerInput,
  GatewayPayment,
  GatewaySubscription,
  InternalPaymentEvent,
  ParsedWebhook,
  PaymentProvider,
  RefundResult,
  WebhookRequestInput,
} from './payment-provider.interface';

// Asaas's own event vocabulary (POST /v3/webhooks docs, "Cobranças" +
// "Assinaturas" categories) -> this platform's internal vocabulary.
// Every event NOT listed here maps to 'Ignored' — see
// `mapEvent`'s own comment for why that's a closed, not open, mapping.
const EVENT_MAP: Record<string, InternalPaymentEvent> = {
  PAYMENT_CREATED: 'PaymentCreated',
  PAYMENT_CONFIRMED: 'PaymentConfirmed',
  PAYMENT_RECEIVED: 'PaymentConfirmed',
  PAYMENT_OVERDUE: 'PaymentOverdue',
  PAYMENT_REFUNDED: 'PaymentRefunded',
  PAYMENT_PARTIALLY_REFUNDED: 'PaymentRefunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'PaymentChargeback',
  PAYMENT_CHARGEBACK_DISPUTE: 'PaymentChargeback',
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: 'PaymentChargeback',
  PAYMENT_DELETED: 'PaymentCanceled',
  PAYMENT_RESTORED: 'PaymentRestored',
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: 'PaymentFailed',
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: 'PaymentFailed',
  PAYMENT_AWAITING_RISK_ANALYSIS: 'PaymentPending',
  PAYMENT_APPROVED_BY_RISK_ANALYSIS: 'PaymentPending',
  PAYMENT_AUTHORIZED: 'PaymentPending',
  PAYMENT_UPDATED: 'PaymentPending',
  SUBSCRIPTION_DELETED: 'SubscriptionCanceled',
  SUBSCRIPTION_INACTIVATED: 'SubscriptionCanceled',
  SUBSCRIPTION_CREATED: 'SubscriptionSynced',
  SUBSCRIPTION_UPDATED: 'SubscriptionSynced',
};

const BILLING_TYPE: Record<CreateSubscriptionInput['paymentMethod'], string> = {
  pix: 'PIX',
  card: 'CREDIT_CARD',
};

const CYCLE: Record<CreateSubscriptionInput['billingPeriod'], string> = {
  monthly: 'MONTHLY',
  quarterly: 'QUARTERLY',
  semiannual: 'SEMIANNUALLY',
  annual: 'YEARLY',
};

interface AsaasCustomer {
  id: string;
}

interface AsaasSubscription {
  id: string;
  status: string;
  externalReference: string | null;
  nextDueDate: string | null;
}

interface AsaasPayment {
  id: string;
  subscription: string | null;
  status: string;
  value: number;
  netValue: number | null;
  currency?: string;
  billingType: string;
  installmentCount?: number | null;
  paymentDate: string | null;
  invoiceUrl?: string | null;
}

interface AsaasList<T> {
  data: T[];
}

interface AsaasPixQrCode {
  encodedImage: string;
  payload: string;
  expirationDate: string | null;
}

interface AsaasRefund {
  status: string;
  value: number | null;
}

interface AsaasWebhookBody {
  id: string;
  event: string;
  payment?: { id: string; subscription?: string | null };
  subscription?: { id: string };
}

/**
 * The ONLY class in this codebase that knows Asaas's own request/
 * response shapes — everything else in the platform depends on
 * `PaymentProvider`, never this. See that interface's own top-of-file
 * doc comment for the input-vocabulary-vs-output-vocabulary split this
 * class is responsible for maintaining.
 */
@Injectable()
export class AsaasProvider implements PaymentProvider {
  readonly name = 'asaas';

  constructor(
    private readonly client: AsaasClient,
    private readonly config: ConfigService,
  ) {}

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ externalCustomerId: string }> {
    const name = [input.firstName, input.lastName].filter(Boolean).join(' ').trim() || input.email;
    const customer = await this.client.post<AsaasCustomer>('/customers', {
      name,
      cpfCnpj: input.cpf,
      email: input.email,
      postalCode: input.address.postalCode,
      address: input.address.addressLine,
      addressNumber: input.address.addressNumber,
      province: input.address.neighborhood,
      externalReference: input.userId,
    });
    return { externalCustomerId: customer.id };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<GatewaySubscription> {
    const sub = await this.client.post<AsaasSubscription>('/subscriptions', {
      customer: input.externalCustomerId,
      billingType: BILLING_TYPE[input.paymentMethod],
      value: centsToAmount(input.amountCents),
      nextDueDate: formatDateOnly(input.firstDueDate),
      cycle: CYCLE[input.billingPeriod],
      description: input.description,
      externalReference: input.externalReference,
    });
    return toGatewaySubscription(sub);
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    const sub = await this.client.get<AsaasSubscription>(`/subscriptions/${externalId}`);
    return toGatewaySubscription(sub);
  }

  async cancelSubscription(externalId: string): Promise<void> {
    await this.client.delete(`/subscriptions/${externalId}`);
  }

  async listSubscriptionPayments(externalId: string): Promise<GatewayPayment[]> {
    const list = await this.client.get<AsaasList<AsaasPayment>>(`/subscriptions/${externalId}/payments`);
    return list.data.map(toGatewayPayment);
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    const payment = await this.client.get<AsaasPayment>(`/payments/${externalId}`);
    return toGatewayPayment(payment);
  }

  async getPixQrCode(paymentId: string): Promise<{ qrCode: string; qrCodeBase64: string; expiresAt: Date | null }> {
    const qr = await this.client.get<AsaasPixQrCode>(`/payments/${paymentId}/pixQrCode`);
    return {
      qrCode: qr.payload,
      qrCodeBase64: qr.encodedImage,
      expiresAt: qr.expirationDate ? new Date(qr.expirationDate) : null,
    };
  }

  async refund(externalId: string, amountCents?: number): Promise<RefundResult> {
    const body = amountCents !== undefined ? { value: centsToAmount(amountCents) } : {};
    const refund = await this.client.post<AsaasRefund>(`/payments/${externalId}/refund`, body);
    return {
      id: externalId,
      status: refund.status ?? null,
      amountCents: refund.value != null ? amountToCents(refund.value) : null,
    };
  }

  /**
   * Asaas authenticates a webhook with a single STATIC token (the
   * `asaas-access-token` header, set once in their dashboard) — there
   * is no per-request signature, no timestamp, nothing that makes a
   * captured request unreplayable. That makes the caller's own
   * mandatory re-fetch-before-acting rule (`PaymentsWebhookService`
   * never trusts this method's parsed body for anything beyond WHICH
   * resource to re-fetch) the real defense here, not this check alone.
   */
  parseWebhook(req: WebhookRequestInput): ParsedWebhook {
    const expected = this.config.get<string>('ASAAS_WEBHOOK_TOKEN');
    if (!expected) {
      throw new UnauthorizedException('Asaas webhooks are not configured on this deployment');
    }

    const received = firstString(req.headers['asaas-access-token']);
    if (!received || !constantTimeEquals(received, expected)) {
      throw new UnauthorizedException('Invalid webhook token');
    }

    const body = req.body as AsaasWebhookBody;
    const rawEvent = body?.event ?? '';
    return {
      notificationId: body?.id ?? '',
      rawEvent,
      internalEvent: EVENT_MAP[rawEvent] ?? 'Ignored',
      paymentExternalId: body?.payment?.id ?? null,
      subscriptionExternalId: body?.subscription?.id ?? body?.payment?.subscription ?? null,
    };
  }
}

function toGatewaySubscription(sub: AsaasSubscription): GatewaySubscription {
  return {
    id: sub.id,
    status: sub.status,
    externalReference: sub.externalReference ?? null,
    nextDueDate: sub.nextDueDate ? new Date(sub.nextDueDate) : null,
    raw: sub,
  };
}

function toGatewayPayment(payment: AsaasPayment): GatewayPayment {
  return {
    id: payment.id,
    status: payment.status,
    statusDetail: null,
    subscriptionExternalId: payment.subscription ?? null,
    amountCents: payment.value != null ? amountToCents(payment.value) : null,
    paidAmountCents: payment.netValue != null ? amountToCents(payment.netValue) : null,
    currency: payment.currency ?? 'BRL',
    paymentMethodId: payment.billingType ?? null,
    installments: payment.installmentCount ?? null,
    approvedAt: payment.paymentDate ? new Date(payment.paymentDate) : null,
    invoiceUrl: payment.invoiceUrl ?? null,
    raw: payment,
  };
}

/** Asaas expects `YYYY-MM-DD`, no time component (confirmed against their own docs' example, `"nextDueDate": "2023-10-15"`). */
function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function firstString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Same constant-time comparison discipline this codebase's earlier billing webhook established for its own HMAC check — a static token compared with `===` would leak its length/prefix through response-timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
