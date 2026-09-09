# Payments — Asaas

> Migrated from Mercado Pago in September 2026. This is the only payment
> provider integrated today; the domain is built behind a
> `PaymentProvider` interface (`apps/api/src/modules/payments/
> payment-provider.interface.ts`) specifically so a second provider
> (Stripe, Pagar.me) can be added later by writing one new class and
> changing one binding in `payments.module.ts` — nothing else in the
> platform would change.

## 1. What Asaas is, and why this shape

[Asaas](https://www.asaas.com) is a Brazilian payment provider offering
Pix, credit card, and boleto, with a native recurring-subscription
product (`POST /v3/subscriptions`) that generates every future charge
on its own and notifies this platform by webhook. That single fact
drove the whole design: **there is no manual "renew" action anywhere in
this codebase anymore** — Pix and card both go through the same
subscription object, and Asaas's own scheduler is what creates each
period's charge.

Card payments use Asaas's own **hosted checkout page**
(`Order.checkoutUrl`) rather than any in-page tokenization — a
deliberate choice (over embedding a Brick-style widget) so raw card
data never reaches this platform's frontend or backend at all, keeping
this the same "we never see a card number" posture the previous
Mercado Pago integration held.

## 2. Creating the Asaas account and getting an API key

1. Sign up at [asaas.com](https://www.asaas.com) (production) and/or
   [sandbox.asaas.com](https://sandbox.asaas.com) (a genuinely separate
   environment — sandbox and production have entirely separate
   accounts, credentials, and data; a sandbox key never works against
   the production API and vice versa).
2. In the dashboard: **Integrações → Chaves de API → Gerar chave de
   API**. Copy it immediately — Asaas shows it once and cannot recover
   it later.
3. Set `ASAAS_API_KEY` in `apps/api/.env` to that value, and
   `ASAAS_ENVIRONMENT` to `sandbox` or `production` accordingly (see §5).

## 3. Sandbox vs. production

`AsaasClient` (`apps/api/src/modules/payments/asaas.client.ts`) derives
the base URL purely from `ASAAS_ENVIRONMENT`:

| `ASAAS_ENVIRONMENT` | Base URL |
|---|---|
| `sandbox` (default) | `https://api-sandbox.asaas.com/v3` |
| `production` | `https://api.asaas.com/v3` |

The default is `sandbox` deliberately — a deployment that forgets to
set this talks to sandbox, never accidentally to production. There is
no test-card-number simulation in sandbox the way some providers offer;
Asaas's sandbox has its own dashboard where you can manually mark a
charge as paid to exercise the webhook end to end (see §11).

## 4. Configuring the webhook

1. In the Asaas dashboard: **Integrações → Webhooks → Adicionar
   Webhook**.
2. **URL do Webhook**: `https://<your-public-api-origin>/api/webhooks/asaas`.
   In local dev, this has to be a real public URL Asaas can reach — a
   tunnel (Cloudflare Tunnel, ngrok) pointed at `localhost:3000` works;
   Asaas cannot reach `localhost` directly.
3. **Versão da API**: `v3`.
4. **Token de autenticação**: click "Gerar Token" — Asaas sends this
   back as the `asaas-access-token` header on every notification. Copy
   it into `ASAAS_WEBHOOK_TOKEN` in `apps/api/.env`.
5. **Tipo de envio**: `Sequencial` (not required for correctness — the
   pipeline is idempotent and order-tolerant either way, see §9 — but
   avoids some out-of-order edge cases for free).
6. **Eventos**: select every event under **Cobranças** and
   **Assinaturas**. Anything not explicitly mapped by this platform
   (`AsaasProvider`'s `EVENT_MAP`) is safely ignored — see §8 — so
   selecting everything costs nothing and avoids missing an event this
   platform DOES care about.
7. Save. Asaas will start sending real notifications the moment any
   payment/subscription event happens on this account.

### The 15-failure lockout

Asaas's own documented behavior: if this webhook endpoint returns a
non-2xx response **15 times in a row**, Asaas **interrupts the entire
sync queue** for this account. New events keep being generated but stop
being delivered until the queue is manually resumed (in the dashboard,
or via their API) — see §12 for what this looks like and how to recover.

This is why `PaymentsWebhookController` does the absolute minimum
synchronously (verify the token, dedupe-insert, enqueue) and always
responds 200 once the token check passes — the actual processing
(`PaymentsWebhookService.process`, which can legitimately fail and
retry) happens in a separate `webhook-processing` BullMQ queue, off the
request path entirely. A processing failure there costs zero strikes
against the 15-failure counter.

## 5. Environment variables

All in `apps/api/.env` (see `apps/api/.env.example` for the same list
with explanatory comments):

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `ASAAS_API_KEY` | Optional at boot, refused (503) at first use if unset | — | From §2 |
| `ASAAS_ENVIRONMENT` | No | `sandbox` | `sandbox` \| `production` |
| `ASAAS_BASE_URL` | No | derived from `ASAAS_ENVIRONMENT` | Override for a proxy/mock — normally never set |
| `ASAAS_WEBHOOK_TOKEN` | Optional at boot, refused (401) at first use if unset | — | From §4 |
| `BILLING_GRACE_DAYS` | No | `3` | Days a subscription may sit `past_due` before billing-cycle suspends it — see §10 |
| `CHECKOUT_ORDER_TTL_MINUTES` | No | `1440` (24h) | How long an abandoned `pending` order holds its subscription's slot before billing-cycle expires it |

Same posture `BILLING_WEBHOOK_SECRET`/the old `MERCADOPAGO_*` vars
always took: unset means the process still boots (every dev/test
environment must start with none of this configured), but the checkout
endpoint and the webhook both refuse loudly (503 / 401) the moment
they're actually used unconfigured — never a silent no-op, never an
unverified payment accepted.

## 6. The checkout flow

```
Customer                    apps/api                         Asaas
   |                            |                               |
   |-- POST /api/client/checkout ->                              |
   |   { planId, templateId,   |                                 |
   |     serverName, variables,|                                 |
   |     paymentMethod }       |                                 |
   |                            |-- lock plan, validate template  |
   |                            |-- create Subscription (pending) |
   |                            |-- create Order (pending)        |
   |                            |   [ONE transaction, then:]      |
   |                            |-- ensureCustomer -------------->|
   |                            |<---------------- externalCustomerId
   |                            |-- createSubscription ---------->|
   |                            |<--------- subscription + first charge
   |                            |-- getPixQrCode (pix)             |
   |                            |   OR reads invoiceUrl (card)    |
   |   <---- Order { pixQrCode | checkoutUrl, status: 'pending' } |
   |                            |                               |
   |  [pix: shows QR in-page]   |                               |
   |  [card: redirects to checkoutUrl, Asaas's OWN page]        |
```

Price, plan resources, and template eligibility are **always** re-read
from the database under `capacity.lockPlan`'s advisory lock
(`OrdersService.createCheckoutOrder`) — nothing the frontend sends
about price/RAM/CPU/disk is ever trusted, mirroring the same rule the
Mercado Pago integration held.

**Idempotency** (payments plan §24): if the same user already has a
`pending` `Order`+`Subscription` pair for the same plan that hasn't
expired, a second checkout attempt returns that SAME order rather than
creating a duplicate — a double-click or a retried request never
creates two subscriptions.

## 7. The subscription model

One Asaas subscription per this platform's `Subscription` row,
`Subscription.externalSubscriptionId` = Asaas's `sub_...` id. Asaas's
own scheduler generates a new charge every `Plan.billingPeriod` cycle —
this platform never calls anything to trigger that; it only reacts to
the resulting webhook events (§8).

`billingPeriod` → Asaas `cycle` mapping (`AsaasProvider`):

| This platform | Asaas |
|---|---|
| `monthly` | `MONTHLY` |
| `quarterly` | `QUARTERLY` |
| `semiannual` | `SEMIANNUALLY` |
| `annual` | `YEARLY` |

`paymentMethod` → Asaas `billingType`: `pix` → `PIX`, `card` →
`CREDIT_CARD`.

## 8. Webhook events

Every event Asaas can send under **Cobranças**/**Assinaturas**, and
what this platform does with it (`AsaasProvider`'s `EVENT_MAP`,
`PaymentsWebhookService.process`). Anything not listed maps to the
internal `'Ignored'` event — acknowledged (200), recorded, no side
effect.

| Asaas event | Internal event | Effect |
|---|---|---|
| `PAYMENT_CREATED` | `PaymentCreated` | Records the payment; if it's a NEW renewal charge (no `Order` yet), captures its Pix QR/checkout URL for the customer to see |
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `PaymentConfirmed` | Verifies the amount, marks the `Order` `paid`, activates the `Subscription` (first charge) or extends its period (renewal) or recovers it from `past_due`/`suspended` — reactivating the server ONLY if this platform's own billing suspended it (§10) |
| `PAYMENT_OVERDUE` | `PaymentOverdue` | Moves the `Subscription` to `past_due`. **Never suspends anything itself** — that's billing-cycle's job, after the grace period (§10) |
| `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED` | `PaymentRefunded` | `Order` → `refunded`, `Subscription` → `suspended` |
| `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | `PaymentChargeback` | Same as a refund |
| `PAYMENT_DELETED` | `PaymentCanceled` | `Order` → `cancelled`, if still `pending` |
| `PAYMENT_RESTORED` | `PaymentRestored` | `Order` back to `pending`, if it was `cancelled` |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS` | `PaymentFailed` | `Order` → `failed`, if still `pending` |
| `PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS`, `PAYMENT_AUTHORIZED`, `PAYMENT_UPDATED` | `PaymentPending` | No state change — not a final outcome yet |
| `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED` | `SubscriptionCanceled` | `Subscription` → `cancelled`, if legal from its current state |
| `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED` | `SubscriptionSynced` | Light courtesy sync of `currentPeriodEndsAt` — never the authority on activation, which stays exclusively `PaymentConfirmed`'s job |

**The webhook body is never trusted.** Every branch above re-fetches the
actual payment/subscription from Asaas's own API
(`provider.getPayment`/`getSubscription`) before acting on it — this
matters even more for Asaas than it did for Mercado Pago, since Asaas
authenticates a webhook with a single static token (§4), not a
signature. The re-fetch is the real defense against a leaked token
being used to forge a `PaymentConfirmed` notification.

## 9. Idempotency

Three independent layers, each already load-bearing before the Asaas
migration and unchanged in spirit:

1. **Notification-level**: `payment_webhook_events.id` = Asaas's own
   event id (`evt_...`) is the primary key — a redelivery of the exact
   same notification hits a unique-constraint conflict on insert and is
   a no-op.
2. **Order-lookup level**: a payment is matched to this platform's
   `Order` by looking up its `Payment` row first (by Asaas's own
   payment id, also a primary key) — if it already exists, its
   `orderId` is authoritative, so two notifications about the SAME
   payment always resolve to the SAME order, never two.
3. **State-guard level**: `applyPaymentOutcome` refuses to re-apply an
   outcome to an `Order` that's already `refunded`/`cancelled`, or
   already `paid` for anything but a refund/chargeback — a duplicate or
   out-of-order notification changes nothing.

A payment with NO existing `Payment` row and NO matching `pending`
`plan_initial` order is treated as a genuinely new **renewal** charge —
`OrdersService`/`PaymentsWebhookService` create a fresh `Order` (`kind:
'plan_renewal'`) for it, mirroring what a manual checkout would have
produced.

## 10. Suspension (inadimplência) and reactivation

```
PAYMENT_OVERDUE
      |
      v
Subscription: past_due          (webhook — no suspension yet)
      |
      | BILLING_GRACE_DAYS later, billing-cycle (daily job) checks:
      | "has this subscription's most recent transition INTO past_due
      |  been more than BILLING_GRACE_DAYS ago?"
      v
Subscription: suspended  +  Server.suspend(..., source: 'billing')
      |
      | customer pays the overdue (or a new) charge
      v
PAYMENT_CONFIRMED (webhook)
      |
      v
Subscription: active  +  Server.unsuspend(..., requireSource: 'billing')
```

**The critical guard**: `ServersService.unsuspend` takes an optional
`requireSource`. Every automated path (the webhook's recovery branch,
billing-cycle) passes `requireSource: 'billing'` — if the server's
CURRENT `suspensionSource` isn't `'billing'` (i.e. an admin suspended it
for abuse/ToS in the meantime), the automated reactivation is a silent
no-op instead of undoing that admin action. Only a human admin, acting
through `POST /api/admin/servers/:id/unsuspend`, can lift a
non-billing suspension.

Pix and card follow the exact same grace-period rule since the Asaas
migration — the old Mercado-Pago-era asymmetry (card deferring to their
own retry cadence) no longer applies, since Asaas's `PAYMENT_OVERDUE`
fires identically for both.

## 11. Testing in sandbox

1. Set `ASAAS_ENVIRONMENT=sandbox` and a sandbox `ASAAS_API_KEY`.
2. Point the webhook (§4) at a tunnel forwarding to your local API.
3. Subscribe to a plan through the panel with Pix — a real (sandbox) Pix
   QR appears in-page.
4. In the Asaas sandbox dashboard, find the resulting charge and mark it
   as received manually (sandbox has no real bank to actually pay
   through) — this fires `PAYMENT_RECEIVED` for real, through the real
   webhook pipeline.
5. Confirm: `Order.status` → `paid`, `Subscription.status` → `active`,
   a `Server` gets provisioned with the PLAN's resources (not the
   template's), `Order.serverId`/`Subscription.serverId` both set.
6. Repeat with `paymentMethod: 'card'` — the checkout response carries
   `checkoutUrl` instead of a QR; visiting it lands on Asaas's own
   sandbox checkout page.
7. Resend the same webhook notification manually from the dashboard's
   webhook log — confirm no second server, no second subscription,
   response still 200 (idempotency, §9).

## 12. Troubleshooting

**Webhook queue interrupted (15-failure lockout, §4)**: check
Integrações → Webhooks → Logs de Requisições in the Asaas dashboard for
a string of non-2xx responses. Fix whatever caused them (an
unreachable/misconfigured API, `ASAAS_WEBHOOK_TOKEN` mismatch after a
rotation, etc.), then resume the queue — the dashboard has a "Reativar
fila" action once the underlying issue is fixed. Missed events during
the interruption are exactly what `billing-reconciliation` (a daily
job, `apps/api/src/queues/billing-reconciliation.processor.ts`) exists
to catch: it independently asks Asaas's own API whether every
`active`/`past_due` subscription still agrees with this platform's copy,
and logs a `billing.reconciliation.divergence` audit entry (never
auto-corrects) when they don't.

**A checkout order fails immediately (`Order.status: 'failed'`, no
webhook involved)**: `OrdersService.startProviderSubscription` throws
whenever `ensureCustomer`/`createSubscription`/`getPixQrCode` fails —
check the API logs for the actual Asaas error (`AsaasClient` logs
`status` + the response body on every non-2xx, never the API key).
Common causes: `ASAAS_API_KEY` unset/wrong environment, the customer's
CPF failing Asaas's own validation, Asaas being briefly unreachable
(only GET requests retry — see `AsaasClient`'s own doc comment on why
POST never does, to avoid duplicating a charge on retry).

**A payment confirms but the server never gets provisioned**: check
`Order.provisioningStatus`/`provisioningError` in `/admin/payments`. A
transient failure (a node briefly unreachable) retries automatically up
to 5 times; after that, use the "Reprocessar provisionamento" button —
it's the exact same idempotent path (`ProvisioningQueueService`'s
deterministic `provision-<orderId>` job id), so it's always safe to
click again.

**A server got reactivated when it shouldn't have (admin suspension
undone)**: this should be structurally impossible since
`suspension_source`/`requireSource` (§10) — if it happens, it's a bug in
whatever code path called `unsuspend` without passing `requireSource:
'billing'`; check `admin.server.unsuspend`'s audit log entry for which
caller/actor triggered it.

## 13. Cancellation

`POST /api/client/subscriptions/:id/cancel` (`ClientOrdersController`,
`OrdersService.cancelSubscriptionForUser`) — the customer's only
self-service transition. **Always** cancels at Asaas first (stops any
further charge from ever being generated), regardless of the
`atPeriodEnd` flag:

- **Immediate** (default): `Subscription` → `cancelled` right away.
- **`atPeriodEnd: true`**: `Subscription` stays exactly as it is (server
  keeps running) with `cancelAtPeriodEnd` set; billing-cycle finishes
  the cancellation once `currentPeriodEndsAt` passes. Nothing is owed
  either way — the provider-side subscription is already gone the
  moment this endpoint returns, so no renewal charge would ever arrive
  regardless.

Never deletes server data automatically (payments plan's own rule) —
only ever changes `Subscription`/`Server` status.

## 14. Refunds

Admin-only, `/admin/payments` → order detail → "Reembolsar" (reason
required). `OrdersService.refundAsAdmin` **only triggers the refund at
Asaas** (`provider.refund`) — it never marks the order/payment
`refunded` itself. That state change happens exclusively through the
SAME `PaymentRefunded` webhook path a customer-initiated or Asaas-side
refund already goes through, so there is only ever one code path that
decides "this order is refunded," never two that could disagree.

## 15. Going to production

1. Generate a **production** API key (§2) — a completely different
   account/dashboard from sandbox, not just a mode toggle.
2. Set `ASAAS_API_KEY` to the production key and `ASAAS_ENVIRONMENT=production`
   in the production `.env`.
3. Configure a SEPARATE production webhook (§4) pointing at the real
   public API origin — sandbox and production webhooks are entirely
   independent; the sandbox one configured for local dev does nothing
   in production.
4. Set `ASAAS_WEBHOOK_TOKEN` to the NEW token that webhook generates
   (never reuse the sandbox one).
5. Verify `PUBLIC_SITE_URL`/`PANEL_URL` resolve to real HTTPS origins —
   unrelated to Asaas directly, but every other public-facing URL this
   platform generates depends on them being correct.
6. Do one real, small-value end-to-end purchase before announcing —
   confirm the webhook arrives, the order activates, and the server
   provisions, exactly as in §11 but against the real API.
