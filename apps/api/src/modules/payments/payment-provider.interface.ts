/**
 * The ONE seam between this platform's own order/payment model and
 * whichever external provider processes money. Every other service in
 * this module (OrdersService, the webhook handler, ProvisioningService,
 * the billing-cycle job) depends on THIS interface and the
 * `@Inject(PAYMENT_PROVIDER)` token — never on `AsaasClient` directly,
 * never on an HTTP call to Asaas's API. Adding a second provider later
 * (Stripe, Pagar.me — the explicit reason this interface exists) means
 * writing a new class that implements it and changing one binding in
 * `payments.module.ts`; nothing else in the platform changes.
 *
 * Two different vocabularies are deliberately mixed in this file, and
 * that split is intentional, not sloppy:
 *  - INPUT fields (`paymentMethod`, `billingPeriod`) use THIS platform's
 *    own vocabulary — the domain never has to know Asaas calls a Pix
 *    subscription `billingType: 'PIX'` or a monthly cycle `'MONTHLY'`.
 *    Each concrete provider (`AsaasProvider`) translates in one place.
 *  - OUTPUT `status` fields stay the PROVIDER's own vocabulary,
 *    UNTRANSLATED — `PaymentsService.recordFromGateway` and
 *    `PaymentsWebhookService` are the only places that map a status
 *    onto this platform's own order/subscription states. Translating a
 *    provider's status into our own enum at the boundary would just
 *    move the coupling one file over, not remove it.
 *
 * Every amount in this file is integer CENTS — Asaas's own API takes a
 * decimal `value` (e.g. `75.56`), never cents; that conversion happens
 * exactly once, inside `AsaasProvider`, via `money.ts`. Nothing outside
 * this module should ever need to know that.
 */

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * A normalized webhook event, after this platform's own doctrine has
 * already been applied to the provider's raw event name. Kept as a
 * closed union (not a passthrough string) specifically so a switch over
 * it is exhaustively checked by the compiler — an event this platform
 * doesn't yet handle must be an explicit, deliberate choice (mapped to
 * `'Ignored'`), never a typo that silently falls through.
 */
export type InternalPaymentEvent =
  | 'PaymentCreated'
  | 'PaymentConfirmed'
  | 'PaymentOverdue'
  | 'PaymentRefunded'
  | 'PaymentChargeback'
  | 'PaymentCanceled'
  | 'PaymentRestored'
  | 'PaymentFailed'
  | 'PaymentPending'
  | 'SubscriptionCanceled'
  | 'SubscriptionSynced'
  | 'Ignored';

export interface PayerAddressInput {
  postalCode: string;
  addressLine: string;
  addressNumber: string;
  neighborhood: string;
  city: string;
  /** Two-letter Brazilian state code (UF). */
  state: string;
}

/**
 * Enough to create (or find) the provider's own customer record for a
 * user. Every field comes from the billing profile
 * `SubscriptionsService.createPendingSubscription` already requires to
 * be complete before checkout — nothing is re-collected.
 */
export interface EnsureCustomerInput {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Digits only. */
  cpf: string;
  address: PayerAddressInput;
}

/**
 * Creates a recurring subscription — the ONLY way this platform charges
 * a customer since the Asaas migration (Checkout Bricks' one-off-Pix-
 * plus-manual-renewal model and the separate card-preapproval model are
 * both gone; Asaas's `POST /v3/subscriptions` acts as its own scheduler
 * for EITHER payment method, generating a new charge every cycle on its
 * own and notifying this platform by webhook — see
 * `PaymentsWebhookService`'s own doc comment for what happens on each
 * notification).
 */
export interface CreateSubscriptionInput {
  externalCustomerId: string;
  /** Becomes the provider's own `externalReference` on the SUBSCRIPTION — the only key `getSubscription`/webhook lookups by subscription are allowed to use. Same generator as `Order.externalReference` (`OrdersService.generateExternalReference`). */
  externalReference: string;
  /** Human-readable line shown on the buyer's statement/receipt (the plan's name). */
  description: string;
  /** Charged every cycle — the SAME amount each time. */
  amountCents: number;
  /** ISO 4217, e.g. 'BRL'. */
  currency: string;
  paymentMethod: 'pix' | 'card';
  billingPeriod: 'monthly' | 'quarterly' | 'semiannual' | 'annual';
  /** When the FIRST charge should be generated — always "today" in practice, since checkout is synchronous from the customer's point of view. */
  firstDueDate: Date;
}

/**
 * `status` is the provider's own vocabulary for a subscription
 * (`ACTIVE`, `INACTIVE`, `EXPIRED`, ...) — untranslated, same posture
 * `GatewayPayment.status` already takes. `PaymentsWebhookService` is
 * the one place that maps it onto `Subscription.status`.
 */
export interface GatewaySubscription {
  id: string;
  status: string;
  externalReference: string | null;
  nextDueDate: Date | null;
  raw: unknown;
}

/**
 * The subset of a provider payment this platform actually persists
 * (`payments` table) — never card data, never anything beyond what
 * `raw` (a sanitized snapshot for admin diagnosis) already carries.
 */
export interface GatewayPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  /** The provider's own subscription id this charge belongs to (Asaas's `payment.subscription`) — the PRIMARY key `PaymentsWebhookService` uses to find this platform's `Subscription`/`Order`. Only the very FIRST charge of a subscription is also reachable by `externalReference` (it's the one `OrdersService` itself created); every renewal charge Asaas generates on its own carries no reference back to a specific `Order` at all — only to the `Subscription`, which is exactly why lookups go through this field, never `externalReference`, once a subscription exists. */
  subscriptionExternalId: string | null;
  amountCents: number | null;
  paidAmountCents: number | null;
  currency: string | null;
  paymentMethodId: string | null;
  installments: number | null;
  approvedAt: Date | null;
  /** Asaas's own hosted checkout page for this ONE charge (`invoiceUrl`) — only meaningful for `paymentMethod: 'card'` (checkout redirects here instead of tokenizing in-page, per the "checkout hospedado" decision); `null` for Pix, which never redirects. Written straight to `Order.checkoutUrl`. */
  invoiceUrl: string | null;
  raw: unknown;
}

export interface RefundResult {
  id: string;
  status: string | null;
  amountCents: number | null;
}

/**
 * A webhook event, already verified authentic (the provider's own
 * static token/signature checked BEFORE this is returned — see
 * `parseWebhook`'s own doc comment) and translated to this platform's
 * internal vocabulary. `paymentExternalId`/`subscriptionExternalId` are
 * whichever the raw event actually carried — a payment-shaped event
 * sets the first, a subscription-shaped event sets the second, never
 * both.
 */
export interface ParsedWebhook {
  /** The provider's own event id — the ONLY thing `payment_webhook_events.id` is keyed on for dedupe (at-least-once delivery, same PK-as-idempotency-key doctrine `Payment.id` already uses). */
  notificationId: string;
  /** The provider's raw event name (e.g. `'PAYMENT_RECEIVED'`) — kept for `payment_webhook_events.type` and audit logs, even though the domain switches on `internalEvent`, never this. */
  rawEvent: string;
  internalEvent: InternalPaymentEvent;
  paymentExternalId: string | null;
  subscriptionExternalId: string | null;
}

/**
 * Framework-agnostic shape of an inbound webhook request — deliberately
 * NOT `FastifyRequest`, so this interface (and every implementation of
 * it) stays free of an HTTP-framework dependency. The controller is
 * responsible for narrowing the real request into this shape before
 * calling `parseWebhook`.
 */
export interface WebhookRequestInput {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface PaymentProvider {
  /** Short, stable identifier — `'asaas'` — written to `Order.provider`/`PaymentWebhookEvent.provider`/`PaymentCustomer.provider`. Never used for behavior outside `modules/payments/` (see this file's own top-of-file doc comment). */
  readonly name: string;

  /** Creates or reuses (idempotent per `userId`) the provider's own customer record. Callers persist the result in `PaymentCustomer`, keyed `(provider, userId)`, so this is only ever called once per user per provider. */
  ensureCustomer(input: EnsureCustomerInput): Promise<{ externalCustomerId: string }>;

  /** Creates a recurring subscription — the provider itself generates and notifies every future charge; this platform never calls a separate "renew" endpoint again. */
  createSubscription(input: CreateSubscriptionInput): Promise<GatewaySubscription>;
  /** Re-fetches the subscription from the provider's own API — the webhook body is never trusted as the financial source of truth (payments plan's own rule). */
  getSubscription(externalId: string): Promise<GatewaySubscription>;
  /** Cancels at the provider — MUST be called before this platform cancels its own `Subscription` row, or the customer keeps being charged with no record on our side of why. */
  cancelSubscription(externalId: string): Promise<void>;
  /** Every charge the provider has generated for one subscription, newest first — the reconciliation job's own source of truth, compared against this platform's `Payment` rows for the same subscription. */
  listSubscriptionPayments(externalId: string): Promise<GatewayPayment[]>;

  /** Re-fetches ONE payment by its own id — same "never trust the webhook body" posture as `getSubscription`. */
  getPayment(externalId: string): Promise<GatewayPayment>;
  /** The Pix QR for one payment — `encodedImage`/`payload` in Asaas's own vocabulary, mapped to this platform's `qrCode`/`qrCodeBase64` naming (matches `Order.pixQrCode`/`pixQrCodeBase64`, unchanged from the Mercado Pago era). */
  getPixQrCode(paymentId: string): Promise<{ qrCode: string; qrCodeBase64: string; expiresAt: Date | null }>;
  /** Omit `amountCents` for a full refund; provide it for a partial one. */
  refund(externalId: string, amountCents?: number): Promise<RefundResult>;

  /**
   * Verifies the request's authenticity BEFORE anything in the body is
   * trusted, and translates the provider's own event name into
   * `InternalPaymentEvent`. Throws (`UnauthorizedException`) when
   * verification fails; never returns a "maybe legitimate" result. This
   * is MORE load-bearing for Asaas than it was for Mercado Pago: Asaas
   * authenticates a webhook with a single static token (no HMAC
   * signature), so `parseWebhook` re-fetching the actual resource
   * before acting (done by the caller, not here) is the only real
   * defense against a leaked token being used to forge events.
   */
  parseWebhook(req: WebhookRequestInput): ParsedWebhook;
}
