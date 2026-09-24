import { UnauthorizedException } from '@nestjs/common';
import { classifyMercadoPagoPayment, classifyMercadoPagoPreapproval } from '../src/modules/payments/mercadopago.provider';
import type {
  BoletoCharge,
  CreateBoletoChargeInput,
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
} from '../src/modules/payments/payment-provider.interface';

/**
 * The ONE fake provider every payments e2e spec injects, via
 * `.overrideProvider(PAYMENT_PROVIDER).useValue(new FakePaymentProvider())`.
 * `MERCADOPAGO_ACCESS_TOKEN` is unset in the test environment
 * (correctly — no test should ever call the real Mercado Pago API), so
 * this is what the whole payments module talks to instead.
 *
 * Previously this class was copy-pasted into three spec files, which is
 * exactly how a fake drifts from the interface it's meant to stand in
 * for. It lives here once now.
 *
 * Two deliberate fidelity choices:
 *  - `classifyPayment`/`classifySubscription` delegate to the REAL
 *    mapping functions (`classifyMercadoPago*`), so a spec asserting on
 *    `approved` → activation is asserting the same vocabulary
 *    production uses.
 *  - `parseWebhook` is intentionally NOT the real HMAC check (that is
 *    `MercadoPagoProvider.parseWebhook`'s own responsibility, covered
 *    by `mercadopago-signature.spec.ts`). It is gated on a fake header,
 *    precise enough to exercise `PaymentsWebhookController`'s OWN
 *    responsibility — verify, dedupe, enqueue, respond 2xx — in
 *    isolation.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'mercadopago';
  subscriptions = new Map<string, GatewaySubscription>();
  payments = new Map<string, GatewayPayment>();

  /** Set right before a checkout call to simulate Mercado Pago being unreachable — reset immediately after, an explicit flag rather than a magic string. */
  forceCreateChargeFailure = false;

  async createPixCharge(input: CreatePixChargeInput): Promise<PixCharge> {
    if (this.forceCreateChargeFailure) {
      throw new Error('simulated Mercado Pago failure');
    }
    const id = `fake-pay-${input.externalReference}`;
    const charge: PixCharge = {
      id,
      status: 'pending',
      statusDetail: null,
      // A standalone pix charge belongs to no preapproval — exactly like
      // the real thing, it is only findable by external_reference.
      subscriptionExternalId: null,
      externalReference: input.externalReference,
      amountCents: input.amountCents,
      paidAmountCents: null,
      currency: input.currency,
      paymentMethodId: 'pix',
      paymentTypeId: 'bank_transfer',
      installments: null,
      approvedAt: null,
      raw: { payerEmail: input.payer.email },
      qrCode: `fake-qr-copy-paste-${id}`,
      qrCodeBase64: 'ZmFrZS1xci1wbmc=',
      expiresAt: input.expiresAt,
    };
    this.payments.set(id, charge);
    return charge;
  }

  async createBoletoCharge(input: CreateBoletoChargeInput): Promise<BoletoCharge> {
    if (this.forceCreateChargeFailure) {
      throw new Error('simulated Mercado Pago failure');
    }
    const id = `fake-boleto-${input.externalReference}`;
    const charge: BoletoCharge = {
      id,
      status: 'pending',
      statusDetail: 'pending_waiting_payment',
      subscriptionExternalId: null,
      externalReference: input.externalReference,
      amountCents: input.amountCents,
      paidAmountCents: null,
      currency: input.currency,
      paymentMethodId: 'bolbradesco',
      paymentTypeId: 'ticket',
      installments: null,
      approvedAt: null,
      raw: { payerEmail: input.payer.email },
      ticketUrl: `https://fake.mercadopago.test/boleto/${id}`,
      digitableLine: '23793380296060054351030006333303799140000020000',
      expiresAt: input.expiresAt,
    };
    this.payments.set(id, charge);
    return charge;
  }

  async createCardSubscription(input: CreateCardSubscriptionInput): Promise<GatewaySubscription> {
    if (this.forceCreateChargeFailure) {
      throw new Error('simulated Mercado Pago failure');
    }
    const id = `fake-preapproval-${input.externalReference}`;
    const subscription: GatewaySubscription = {
      id,
      // A brand-new preapproval is `pending` until the customer
      // authorizes it on Mercado Pago's page — never `authorized` at
      // creation, and never paid.
      status: 'pending',
      externalReference: input.externalReference,
      nextDueDate: null,
      initPoint: `https://fake.mercadopago.test/checkout/${id}`,
      raw: { payerEmail: input.payer.email },
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  async getPayment(externalId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(externalId);
    if (!payment) throw new Error(`test setup error: no fake payment ${externalId}`);
    return payment;
  }

  async getAuthorizedPayment(externalId: string): Promise<GatewayPayment> {
    return this.getPayment(externalId);
  }

  async getSubscription(externalId: string): Promise<GatewaySubscription> {
    const sub = this.subscriptions.get(externalId);
    if (!sub) throw new Error(`test setup error: no fake subscription ${externalId}`);
    return sub;
  }

  async cancelSubscription(externalId: string): Promise<void> {
    const sub = this.subscriptions.get(externalId);
    if (sub) this.subscriptions.set(externalId, { ...sub, status: 'cancelled' });
  }

  async refund(externalId: string, amountCents?: number): Promise<RefundResult> {
    return { id: `fake-refund-${externalId}`, status: 'approved', amountCents: amountCents ?? null };
  }

  classifyPayment(payment: GatewayPayment): InternalPaymentEvent {
    return classifyMercadoPagoPayment(payment.status);
  }

  classifySubscription(subscription: GatewaySubscription): InternalPaymentEvent {
    return classifyMercadoPagoPreapproval(subscription.status);
  }

  parseWebhook(req: WebhookRequestInput): ParsedWebhook {
    if (req.headers['x-fake-token'] !== 'valid') {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    const body = (req.body ?? {}) as { id?: string; type?: string; action?: string; data?: { id?: string } };
    const type = body.type ?? 'payment';
    return {
      notificationId: String(body.id ?? ''),
      rawEvent: body.action ?? type,
      resourceKind: type === 'payment' ? 'payment' : type === 'subscription_preapproval' ? 'preapproval' : type === 'subscription_authorized_payment' ? 'authorized_payment' : null,
      resourceId: body.data?.id ?? null,
    };
  }

  // ---- test-only helpers (not part of PaymentProvider) ----

  /** Moves a fake charge to a new Mercado Pago status, the way a real payment changes between two notifications. */
  setPaymentStatus(id: string, status: string, patch: Partial<GatewayPayment> = {}): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`test setup error: no fake payment ${id}`);
    this.payments.set(id, {
      ...payment,
      status,
      approvedAt: status === 'approved' ? (patch.approvedAt ?? new Date()) : payment.approvedAt,
      paidAmountCents: status === 'approved' ? (patch.paidAmountCents ?? payment.amountCents) : payment.paidAmountCents,
      ...patch,
    });
  }

  /** Registers a charge Mercado Pago generated on its own for a card subscription (a recurring `authorized_payment`), which references only the preapproval. */
  addRecurringCharge(preapprovalId: string, id: string, status: string, amountCents: number, currency = 'BRL'): GatewayPayment {
    const payment: GatewayPayment = {
      id,
      status,
      statusDetail: null,
      subscriptionExternalId: preapprovalId,
      externalReference: null,
      amountCents,
      paidAmountCents: status === 'approved' ? amountCents : null,
      currency,
      paymentMethodId: 'credit_card',
      paymentTypeId: 'credit_card',
      installments: 1,
      approvedAt: status === 'approved' ? new Date() : null,
      raw: {},
    };
    this.payments.set(id, payment);
    return payment;
  }

  setSubscriptionStatus(id: string, status: string): void {
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`test setup error: no fake subscription ${id}`);
    this.subscriptions.set(id, { ...sub, status });
  }
}
