import { z } from 'zod';

/**
 * An optional secret that may appear in a `.env` as an EMPTY line.
 * `.env.example` ships every optional key with no value, so a deployment
 * that copies it verbatim ends up with `MERCADOPAGO_ACCESS_TOKEN=` —
 * present, but empty. A plain `.string().min(1).optional()` treats that
 * as an INVALID value rather than an absent one and refuses to boot,
 * which is exactly backwards: an empty line means "not configured yet",
 * the state every one of these vars is explicitly allowed to be in.
 */
function optionalSecret() {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional());
}

/** Same, for an optional URL. */
function optionalUrl() {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional());
}

// Architecture doc 3.6: the process refuses to start on any missing or
// invalid env var, validated once at boot via Zod inside
// ConfigModule.forRoot({ validate }). No defaults for secrets — a missing
// secret must be a startup failure, never a silently-empty string.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // app_user (RLS-restricted) — what PrismaService actually connects as.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Table-owner role — used only by `prisma migrate`, never at runtime.
  DIRECT_DATABASE_URL: z.string().min(1, 'DIRECT_DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // A separate logical Redis DB from the cache/denylist above (architecture
  // doc 3.7: "Separate Redis DB from cache") — BullMQ's own bookkeeping
  // keys (job data, repeat schedules, locks) live here so a `FLUSHDB` or
  // TTL policy aimed at cache data can never collide with queue state.
  QUEUE_REDIS_URL: z.string().min(1).default('redis://localhost:6379/1'),

  // 32 random bytes, base64 — used by CryptoService for AES-256-GCM
  // envelope encryption of secrets at rest (architecture doc 3.6).
  APP_KEY: z
    .string()
    .min(1, 'APP_KEY is required')
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'APP_KEY must be 32 bytes, base64-encoded',
    }),
  APP_KEY_PREVIOUS: z.string().optional(),
  // Operator-incremented generation counter — bump this (and move the old
  // APP_KEY into APP_KEY_PREVIOUS) on every rotation. See CryptoService's
  // doc comment for why this must be explicit rather than derived.
  APP_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // HS512 secret for access/refresh session JWTs (architecture doc 3.3).
  JWT_SESSION_SECRET: z.string().min(32, 'JWT_SESSION_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(1_209_600), // 14 days

  PANEL_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  // Google OpenID Connect is optional. All three settings are required
  // together when the provider is enabled; GoogleOAuthService deliberately
  // refuses the flow at use time when any is absent, so local/dev installs
  // keep working without a Google Cloud project.
  GOOGLE_OAUTH_CLIENT_ID: optionalSecret(),
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecret(),
  GOOGLE_OAUTH_REDIRECT_URI: optionalUrl(),

  // Client-features Fase 8: which AssistantProvider answers
  // /api/client/assistant/chat. 'kb' (default) is the deterministic
  // knowledge base — no external calls, no cost, no key needed. 'llm' is
  // a future adapter behind the SAME AssistantProvider interface;
  // ASSISTANT_LLM_API_KEY is optional here (unlike every REQUIRED secret
  // above) because requiring it would force every dev/test deployment to
  // configure an LLM key just to boot — AssistantModule's provider
  // factory falls back to 'kb' with a boot warning if 'llm' is requested
  // without a key, deliberately different from MERCADOPAGO_ACCESS_TOKEN's
  // refuse-at-use-time below: a customer-facing assistant that 500s on every
  // message is worse than one that quietly answers from the catalog.
  ASSISTANT_PROVIDER: z.enum(['kb', 'llm']).default('kb'),
  ASSISTANT_LLM_API_KEY: optionalSecret(),

  // Modrinth requires an identifying User-Agent. No credential is needed
  // for public catalog reads; operators may override this to add contact
  // information as recommended by the provider.
  MODRINTH_USER_AGENT: z.string().min(3).default('gxhost/hosting-panel/0.1.0'),

  // Client account management, Fase 1 — generic SMTP for password-reset
  // emails, no specific provider baked in. All optional, same posture as
  // ASSISTANT_LLM_API_KEY just above (not MERCADOPAGO_ACCESS_TOKEN's own
  // refuse-at-use-time below): MailService falls back to logging the reset
  // link instead of failing when MAIL_HOST is unset, since the
  // forgot-password endpoint must always return 200 regardless of mail
  // outcome (anti-enumeration) — a "refuse" posture would have nowhere
  // safe to surface.
  MAIL_HOST: optionalSecret(),
  MAIL_PORT: z.coerce.number().int().positive().optional(),
  MAIL_USERNAME: z.string().optional(),
  MAIL_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().optional(),

  // Commercial site (subscriptions plan) — public self-signup is OFF by
  // default so an existing deployment's behavior never changes on
  // upgrade: today only an admin can create a user (`POST
  // /api/admin/users`), and that stays true until an operator
  // explicitly opts in. `z.coerce.boolean()` is deliberately NOT used
  // here — it treats any non-empty string (including the literal text
  // "false") as true, which would make `ALLOW_PUBLIC_REGISTRATION=false`
  // in a .env file silently turn registration ON. An enum + explicit
  // transform has no such trap.
  ALLOW_PUBLIC_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Canonical public origin for SEO (canonical URLs, sitemap.xml, OG
  // tags) — defaults to PANEL_URL since today they're the same origin;
  // only needs to diverge if the commercial site is ever served from a
  // different domain than the panel app itself.
  PUBLIC_SITE_URL: z.string().url().optional(),

  // Payments — Mercado Pago. All optional, refuse-at-USE-time posture
  // (not ASSISTANT_LLM_API_KEY's silent-fallback posture): a deployment
  // that hasn't configured Mercado Pago must fail loudly the moment a
  // customer tries to check out, never boot-fail (every dev/test
  // environment must still start with none of this configured) and
  // never silently accept an unverifiable payment.
  //
  // Sandbox vs production is decided ENTIRELY by which token this is —
  // `TEST-…` for sandbox, `APP_USR-…` for production. Mercado Pago
  // serves both from the same host, so unlike the provider this
  // replaced there is deliberately no environment switch: a deployment
  // cannot point "production credentials" at a sandbox URL by mistake,
  // because there is only one URL.
  MERCADOPAGO_ACCESS_TOKEN: optionalSecret(),
  // The application's webhook secret, from the Mercado Pago dashboard
  // (Suas integrações > a aplicação > Webhooks). A DIFFERENT value from
  // the access token. `MercadoPagoProvider.parseWebhook` HMACs the
  // notification's own manifest with it and compares in constant time;
  // unset means webhooks are unverifiable, and an unverifiable
  // notification is refused rather than trusted.
  MERCADOPAGO_WEBHOOK_SECRET: optionalSecret(),
  // The public URL Mercado Pago posts notifications to, sent as
  // `notification_url` on every charge this platform creates. Optional:
  // falls back to `${PUBLIC_SITE_URL}/api/webhooks/mercadopago`. Needed
  // explicitly in local development, where the API is only reachable
  // through a tunnel that is not PUBLIC_SITE_URL.
  MERCADOPAGO_NOTIFICATION_URL: optionalUrl(),
  // Override for the API base URL — only needed for something unusual
  // (a mock server in CI). Normally unset.
  MERCADOPAGO_BASE_URL: optionalUrl(),

  // Anti-bot for login/register/forgot-password (Cloudflare Turnstile).
  // Optional, and off (verification skipped entirely) when unset — the
  // same "explicit opt-in, zero dev/test friction" posture
  // ALLOW_PUBLIC_REGISTRATION already uses, deliberately NOT
  // MERCADOPAGO_ACCESS_TOKEN's refuse-at-use-time above: an unconfigured
  // deployment should behave exactly like it did before this feature
  // existed (nobody locked out of login), not fail every auth attempt
  // because nobody has set up a Cloudflare account yet. The site key
  // (public, safe in a browser bundle) is a SEPARATE var in the panel's
  // own build — VITE_TURNSTILE_SITE_KEY, apps/panel/.env — never here.
  TURNSTILE_SECRET_KEY: optionalSecret(),

  // Grace window between a subscription's currentPeriodEndsAt and the
  // server actually being suspended for non-payment (payments plan's
  // inadimplência flow) — a fixed operational knob, not a secret.
  BILLING_GRACE_DAYS: z.coerce.number().int().nonnegative().default(3),
  // How long a `pending` order (and the subscription slot it holds)
  // survives an abandoned checkout before the billing-cycle job expires
  // it — see Order.expiresAt's own doc comment in schema.prisma.
  CHECKOUT_ORDER_TTL_MINUTES: z.coerce.number().int().positive().default(1440),

  // Public-exposure plan (VPS gateway over WireGuard). Deliberately NO
  // PUBLIC_GATEWAY_HOST/PUBLIC_GATEWAY_IP/PUBLIC_GATEWAY_CONTROL_URL vars
  // here — a gateway is a `Gateway` DB row (apps/api/src/modules/gateway),
  // not a single env-configured target, because the whole point is
  // supporting more than one later without a code change. With zero
  // `Gateway` rows (every environment's default, including every
  // dev/test one), GatewayService.ensureRouteForServer no-ops and every
  // existing behavior — the customer sees plain ip:port — is unchanged.
  //
  // The shared bearer secret HttpGatewayDriver presents to a gateway's
  // own control sidecar (apps/gateway) — refuse-at-use-time like
  // MERCADOPAGO_ACCESS_TOKEN above, never boot-fail: a dev/test
  // deployment with no gateway configured must still start.
  PUBLIC_GATEWAY_TOKEN: optionalSecret(),
  // The public-port pool GatewayService.createRouteWithFreePort walks
  // when a server's own internal port is already taken on that gateway
  // (two nodes can and do share the same internal allocation range).
  PUBLIC_GATEWAY_PORT_RANGE: z
    .string()
    .regex(/^\d{1,5}-\d{1,5}$/, 'PUBLIC_GATEWAY_PORT_RANGE must look like "25565-25664"')
    .default('25565-25664'),
  // Optional DNS zone for the `<shortId>.mc.<zone>` hostname pattern
  // (public-address.ts). Unset (the default) means every server's
  // public address is the gateway's own `publicHost:port` instead — no
  // domain required to use this feature at all.
  PUBLIC_GATEWAY_HOSTNAME_ZONE: optionalSecret(),
  // Which DnsProvider GatewayModule binds — 'none' (default) never
  // touches DNS; 'powerdns' additionally requires the three vars below.
  // See docs/DNS-POWERDNS.md before turning this on. (Previously also
  // had a 'cloudflare' option — removed: game-server DNS now runs on
  // GXhost's own PowerDNS nameservers instead of a third-party provider,
  // per docs/DNS-POWERDNS.md's own reasoning. `gxhost.com.br` itself
  // — site/painel/api.gxhost.com.br — is unrelated to this var entirely
  // and can stay on whatever DNS host it already uses.)
  PUBLIC_GATEWAY_DNS_PROVIDER: z.enum(['none', 'powerdns']).default('none'),
  // The zone this platform's own PowerDNS is authoritative for — the one
  // that actually exists as a zone in PowerDNS and that the REST API's
  // `/zones/{zone}` path names. This is NOT always the same value as
  // PUBLIC_GATEWAY_HOSTNAME_ZONE above, and conflating the two was a real
  // production bug: hostnames are composed as `<shortId>.mc.<zone>`, so
  // PUBLIC_GATEWAY_HOSTNAME_ZONE is the registrable apex
  // ("gxhost.com.br"), while a deployment that delegates only the game
  // subdomain (the recommended setup — the apex keeps serving the site,
  // panel and API from wherever it already lives) has PowerDNS
  // authoritative for "mc.gxhost.com.br" alone. Patching "gxhost.com.br."
  // there answers 404 and every route silently keeps its plain ip:port.
  //
  // Unset ⇒ falls back to PUBLIC_GATEWAY_HOSTNAME_ZONE, which is correct
  // for the other valid topology: the whole apex delegated to PowerDNS.
  PUBLIC_GATEWAY_DNS_ZONE: optionalSecret(),
  // Base URL of this platform's own PowerDNS Authoritative Server's REST
  // API (e.g. "http://10.10.0.1:8081") — reachable only over the private
  // network/WireGuard, never the public internet (see
  // docs/DNS-POWERDNS.md's own security section).
  PUBLIC_GATEWAY_DNS_API_URL: optionalUrl(),
  // The API key PowerDNS's `webserver-password`/`api-key` config expects
  // in the `X-API-Key` header. Kept under the SAME var name the removed
  // Cloudflare provider used (both are just "the current DNS provider's
  // credential") rather than renamed, so an existing deployment's env
  // file needs one value swapped, not a new key added.
  PUBLIC_GATEWAY_DNS_API_TOKEN: optionalSecret(),
  // PowerDNS's own server identifier in its REST API path
  // (`/api/v1/servers/{id}/...`) — virtually always the literal string
  // "localhost" (PowerDNS's own internal name for "the local instance
  // answering this API call", NOT a hostname to connect to). Optional:
  // every real deployment uses the default.
  PUBLIC_GATEWAY_DNS_SERVER_ID: optionalSecret(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
