import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { PagBankClient } from './pagbank.client';
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
} from './payment-provider.interface';

const RECURRENCE: Record<CreateCardSubscriptionInput['billingPeriod'], { unit: 'MONTH' | 'YEAR'; length: number }> = {
  monthly: { unit: 'MONTH', length: 1 },
  quarterly: { unit: 'MONTH', length: 3 },
  semiannual: { unit: 'MONTH', length: 6 },
  annual: { unit: 'YEAR', length: 1 },
};

interface PagBankAmount {
  value?: number;
  currency?: string;
  summary?: { total?: number; paid?: number; refunded?: number };
}

interface PagBankCharge {
  id: string;
  reference_id?: string | null;
  status: string;
  paid_at?: string | null;
  amount?: PagBankAmount;
  payment_response?: { code?: string; message?: string };
  payment_method?: { type?: string; installments?: number; pix?: { expiration_date?: string } };
  qr_code?: { id?: string; text?: string };
  links?: Array<{ rel?: string; href?: string }>;
}

interface PagBankOrder {
  id: string;
  reference_id?: string | null;
  charges?: PagBankCharge[];
}

interface PagBankCheckout {
  id: string;
  reference_id?: string | null;
  status: string;
  links?: Array<{ rel?: string; href?: string }>;
}

interface PagBankSubscription {
  id: string;
  reference_id?: string | null;
  status: string;
  next_invoice_at?: string | null;
  links?: Array<{ rel?: string; href?: string }>;
}

interface PagBankRecurringPayment {
  id: string;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  invoice?: { id?: string; amount?: { value?: number; currency?: string } };
  payment_method?: { type?: string };
  provider?: { code?: string; message?: string };
}

interface PagBankWebhookBody {
  id?: string;
  status?: string;
  updated_at?: string;
  event?: string;
  resource?: PagBankSubscription & { charge?: { id?: string } };
  charges?: PagBankCharge[];
}

@Injectable()
export class PagBankProvider implements PaymentProvider {
  readonly name = 'pagbank';
  private publicKey: { value: string; loadedAt: number } | null = null;

  constructor(
    private readonly client: PagBankClient,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async createPixCharge(input: CreatePixChargeInput): Promise<PixCharge> {
    const order = await this.client.post<PagBankOrder>(
      '/orders',
      {
        reference_id: input.externalReference,
        customer: {
          name: payerName(input.payer.firstName, input.payer.lastName),
          email: input.payer.email,
          tax_id: input.payer.cpf,
        },
        items: [{ reference_id: input.externalReference, name: input.description.slice(0, 100), quantity: 1, unit_amount: input.amountCents }],
        charges: [
          {
            reference_id: input.externalReference,
            description: input.description.slice(0, 64),
            amount: { value: input.amountCents, currency: input.currency },
            payment_method: { type: 'PIX', pix: { expiration_date: input.expiresAt.toISOString() } },
          },
        ],
        notification_urls: [this.notificationUrl()],
      },
      input.idempotencyKey,
    );
    const charge = order.charges?.[0];
    if (!charge?.id || !charge.qr_code?.text) {
      throw new PaymentProviderRequestError('PagBank retornou uma cobrança Pix sem QR Code', 502);
    }
    const base64Url = charge.links?.find((link) => link.rel === 'QRCODE.BASE64')?.href;
    if (!base64Url) throw new PaymentProviderRequestError('PagBank retornou uma cobrança Pix sem imagem do QR Code', 502);
    const qrCodeBase64 = (await this.client.getText(base64Url)).trim().replace(/^data:image\/png;base64,/, '');
    return {
      ...toGatewayPayment(charge),
      qrCode: charge.qr_code.text,
      qrCodeBase64,
      expiresAt: charge.payment_method?.pix?.expiration_date ? new Date(charge.payment_method.pix.expiration_date) : input.expiresAt,
    };
  }

  async createCardSubscription(input: CreateCardSubscriptionInput): Promise<GatewaySubscription> {
    const checkout = await this.client.post<PagBankCheckout>(
      '/checkouts',
      {
        reference_id: input.externalReference,
        customer: {
          name: payerName(input.payer.firstName, input.payer.lastName),
          email: input.payer.email,
          tax_id: input.payer.cpf,
        },
        customer_modifiable: true,
        items: [{ reference_id: input.externalReference, name: input.description.slice(0, 100), quantity: 1, unit_amount: input.amountCents }],
        payment_methods: [{ type: 'CREDIT_CARD' }],
        payment_methods_configs: [{ type: 'CREDIT_CARD', config_options: [{ option: 'INSTALLMENTS_LIMIT', value: '1' }] }],
        recurrence_plan: { name: input.description.slice(0, 100), interval: RECURRENCE[input.billingPeriod] },
        redirect_url: input.backUrl,
        return_url: input.backUrl,
        redirect_waiting_time: 5,
        notification_urls: [this.notificationUrl()],
        payment_notification_urls: [this.notificationUrl()],
      },
      input.idempotencyKey,
    );
    const initPoint = checkout.links?.find((link) => link.rel === 'PAY')?.href ?? null;
    if (!checkout.id || !initPoint) throw new PaymentProviderRequestError('PagBank retornou um checkout sem link de pagamento', 502);
    return {
      id: checkout.id,
      status: checkout.status,
      externalReference: checkout.reference_id ?? input.externalReference,
      nextDueDate: null,
      initPoint,
      raw: checkout,
    };
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    return toGatewayPayment(await this.client.get<PagBankCharge>(`/charges/${externalId}`));
  }

  async getAuthorizedPayment(externalId: string): Promise<GatewayPayment> {
    if (!externalId.startsWith('SUBS_')) return this.getPayment(externalId);
    const subscription = await this.client.get<PagBankSubscription>(`/subscriptions/${externalId}`, true);
    const invoiceHref = subscription.links?.find((link) => link.rel === 'INVOICES.LAST')?.href;
    const invoiceId = invoiceHref?.match(/\/invoices\/(INVO_[^/?]+)/)?.[1];
    if (!invoiceId) throw new PaymentProviderRequestError('PagBank não informou a última fatura da assinatura', 502);
    const response = await this.client.get<{ payments?: PagBankRecurringPayment[] }>(`/invoices/${invoiceId}/payments`, true);
    const payment = response.payments?.slice().sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)))[0];
    if (!payment) throw new PaymentProviderRequestError('PagBank não informou o pagamento da última fatura', 502);
    return {
      id: payment.id,
      status: payment.status,
      statusDetail: payment.provider?.message ?? payment.provider?.code ?? null,
      subscriptionExternalId: externalId,
      externalReference: null,
      amountCents: payment.invoice?.amount?.value ?? null,
      paidAmountCents: payment.status.toUpperCase() === 'PAID' ? payment.invoice?.amount?.value ?? null : null,
      currency: payment.invoice?.amount?.currency ?? null,
      paymentMethodId: payment.payment_method?.type?.toLowerCase() ?? 'credit_card',
      paymentTypeId: 'credit_card',
      installments: 1,
      approvedAt: payment.status.toUpperCase() === 'PAID' && (payment.updated_at ?? payment.created_at) ? new Date((payment.updated_at ?? payment.created_at)!) : null,
      raw: {
        id: payment.id,
        status: payment.status,
        invoice: payment.invoice,
        payment_method: { type: payment.payment_method?.type },
        provider: payment.provider,
        created_at: payment.created_at,
        updated_at: payment.updated_at,
      },
    };
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    if (externalId.startsWith('CHEC_')) {
      const checkout = await this.client.get<PagBankCheckout>(`/checkouts/${externalId}`);
      return { id: checkout.id, status: checkout.status, externalReference: checkout.reference_id ?? null, nextDueDate: null, initPoint: null, raw: checkout };
    }
    const subscription = await this.client.get<PagBankSubscription>(`/subscriptions/${externalId}`, true);
    return toGatewaySubscription(subscription);
  }

  async cancelSubscription(externalId: string): Promise<void> {
    try {
      if (externalId.startsWith('CHEC_')) {
        await this.client.post(`/checkouts/${externalId}/inactivate`, {}, `cancel-${externalId}`);
      } else {
        await this.client.putSubscription(`/subscriptions/${externalId}/cancel`);
      }
    } catch (error) {
      if (error instanceof PaymentProviderRequestError && error.status === 404) return;
      throw error;
    }
  }

  async refund(externalId: string, amountCents?: number): Promise<RefundResult> {
    if (externalId.startsWith('PAYM_')) {
      const body = amountCents === undefined ? {} : { amount: { value: amountCents, currency: 'BRL' } };
      const refund = await this.client.postSubscription<{ id: string; status?: string; amount?: { value?: number } }>(
        `/payments/${externalId}/refunds`,
        body,
        `refund-${externalId}-${amountCents ?? 'full'}`,
      );
      return { id: refund.id, status: refund.status ?? null, amountCents: refund.amount?.value ?? amountCents ?? null };
    }
    const charge = await this.client.get<PagBankCharge>(`/charges/${externalId}`);
    const amount = amountCents ?? charge.amount?.summary?.paid ?? charge.amount?.value;
    if (!amount) throw new PaymentProviderRequestError('PagBank não informou o valor reembolsável da cobrança', 502);
    const refunded = await this.client.post<PagBankCharge>(`/charges/${externalId}/cancel`, { amount: { value: amount } }, `refund-${externalId}-${amount}`);
    return { id: refunded.id, status: refunded.status ?? null, amountCents: refunded.amount?.summary?.refunded ?? amount };
  }

  classifyPayment(payment: GatewayPayment): InternalPaymentEvent {
    return classifyPagBankPayment(payment.status);
  }

  classifySubscription(subscription: GatewaySubscription): InternalPaymentEvent {
    return classifyPagBankSubscription(subscription.status);
  }

  async parseWebhook(req: WebhookRequestInput): Promise<ParsedWebhook> {
    if (!req.rawBody) throw new UnauthorizedException('Corpo bruto ausente no webhook do PagBank');
    const signatures = headerValues(req.headers['x-payload-signature']);
    if (signatures.length === 0) throw new UnauthorizedException('Assinatura ausente no webhook do PagBank');
    const publicKey = await this.webhookPublicKey();
    const key = createPublicKey(toPem(publicKey));
    const authentic = signatures.some((signature) => {
      try {
        return verify('sha256', req.rawBody!, key, Buffer.from(signature, 'base64'));
      } catch {
        return false;
      }
    });
    if (!authentic) throw new UnauthorizedException('Assinatura inválida no webhook do PagBank');

    const body = (req.body ?? {}) as PagBankWebhookBody;
    const resource = body.resource;
    let resourceKind: ParsedWebhook['resourceKind'] = null;
    let resourceId: string | null = null;
    let rawEvent = body.event ?? 'pagbank.notification';

    if (body.event === 'subscription.recurrence' && resource?.id) {
      resourceKind = 'authorized_payment';
      resourceId = resource.id;
    } else if (body.event?.startsWith('subscription.') && resource?.id) {
      resourceKind = 'preapproval';
      resourceId = resource.id;
    } else if (body.event === 'refund.created' && resource?.charge?.id) {
      resourceKind = 'payment';
      resourceId = resource.charge.id;
    } else if (body.charges?.[0]?.id) {
      resourceKind = 'payment';
      resourceId = body.charges[0].id;
      rawEvent = `charge.${body.charges[0].status.toLowerCase()}`;
    }

    const digest = createHash('sha256').update(req.rawBody).digest('hex').slice(0, 24);
    return {
      notificationId: `pagbank-${resourceId ?? body.id ?? 'unknown'}-${digest}`,
      rawEvent,
      resourceKind,
      resourceId,
    };
  }

  private notificationUrl(): string {
    const explicit = this.config.get<string>('PAGBANK_NOTIFICATION_URL');
    if (explicit) return explicit;
    const base = this.config.get<string>('PUBLIC_SITE_URL') ?? this.config.get<string>('PANEL_URL');
    if (!base) throw new PaymentProviderRequestError('PAGBANK_NOTIFICATION_URL não está configurada', 503);
    return `${base.replace(/\/$/, '')}/api/webhooks/pagbank`;
  }

  private async webhookPublicKey(): Promise<string> {
    if (this.publicKey && Date.now() - this.publicKey.loadedAt < 60 * 60 * 1000) return this.publicKey.value;
    const response = await this.client.get<{ public_key?: string; public_keys?: Array<{ public_key?: string; key?: string }> }>('/public-keys/webhook');
    const value = response.public_key ?? response.public_keys?.[0]?.public_key ?? response.public_keys?.[0]?.key;
    if (!value) throw new UnauthorizedException('PagBank não retornou uma chave pública de webhook');
    this.publicKey = { value, loadedAt: Date.now() };
    return value;
  }
}

export function classifyPagBankPayment(status: string): InternalPaymentEvent {
  const normalized = status.toUpperCase();
  if (normalized === 'PAID' || normalized === 'SUCCESS') return 'PaymentConfirmed';
  if (normalized === 'WAITING' || normalized === 'IN_ANALYSIS' || normalized === 'AUTHORIZED') return 'PaymentPending';
  if (normalized === 'DECLINED' || normalized === 'DENIED') return 'PaymentFailed';
  if (normalized === 'REFUNDED') return 'PaymentRefunded';
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') return 'PaymentCanceled';
  return 'Ignored';
}

export function classifyPagBankSubscription(status: string): InternalPaymentEvent {
  const normalized = status.toUpperCase();
  if (normalized === 'ACTIVE') return 'SubscriptionSynced';
  if (normalized === 'OVERDUE' || normalized === 'SUSPENDED') return 'SubscriptionPastDue';
  if (normalized === 'CANCELED' || normalized === 'CANCELLED' || normalized === 'EXPIRED') return 'SubscriptionCanceled';
  return 'Ignored';
}

function toGatewayPayment(charge: PagBankCharge): GatewayPayment {
  const refunded = charge.amount?.summary?.refunded ?? 0;
  const total = charge.amount?.summary?.total ?? charge.amount?.value ?? 0;
  const status = refunded >= total && total > 0 ? 'REFUNDED' : charge.status;
  return {
    id: charge.id,
    status,
    statusDetail: charge.payment_response?.message ?? charge.payment_response?.code ?? null,
    subscriptionExternalId: null,
    externalReference: charge.reference_id ?? null,
    amountCents: charge.amount?.value ?? charge.amount?.summary?.total ?? null,
    paidAmountCents: charge.amount?.summary?.paid ?? null,
    currency: charge.amount?.currency ?? null,
    paymentMethodId: charge.payment_method?.type?.toLowerCase() ?? null,
    paymentTypeId: charge.payment_method?.type?.toLowerCase() ?? null,
    installments: charge.payment_method?.installments ?? null,
    approvedAt: charge.paid_at ? new Date(charge.paid_at) : null,
    raw: charge,
  };
}

function toGatewaySubscription(subscription: PagBankSubscription): GatewaySubscription {
  return {
    id: subscription.id,
    status: subscription.status,
    externalReference: subscription.reference_id ?? null,
    nextDueDate: subscription.next_invoice_at ? new Date(subscription.next_invoice_at) : null,
    initPoint: null,
    raw: subscription,
  };
}

function payerName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim() || 'Cliente GXHost';
}

function headerValues(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
}

function toPem(base64: string): string {
  if (base64.includes('BEGIN PUBLIC KEY')) return base64;
  const clean = base64.replace(/\s/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${clean.match(/.{1,64}/g)?.join('\n') ?? clean}\n-----END PUBLIC KEY-----`;
}
