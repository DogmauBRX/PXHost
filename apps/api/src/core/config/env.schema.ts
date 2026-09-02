import { z } from 'zod';

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

  // HMAC key for the external payment webhook (architecture doc roadmap
  // M14). Optional, unlike every other secret above — this whole
  // feature is itself marked "(deferred)" in the roadmap, and making it
  // required would force every dev/test deployment to configure a
  // billing secret just to boot. BillingWebhookService refuses to
  // process any event at USE time if this is unset, rather than
  // silently accepting an unverified payload.
  BILLING_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Client-features Fase 8: which AssistantProvider answers
  // /api/client/assistant/chat. 'kb' (default) is the deterministic
  // knowledge base — no external calls, no cost, no key needed. 'llm' is
  // a future adapter behind the SAME AssistantProvider interface;
  // ASSISTANT_LLM_API_KEY is optional here (unlike every REQUIRED secret
  // above) because requiring it would force every dev/test deployment to
  // configure an LLM key just to boot — AssistantModule's provider
  // factory falls back to 'kb' with a boot warning if 'llm' is requested
  // without a key, deliberately different from BillingWebhookService's
  // refuse-at-use-time: a customer-facing assistant that 500s on every
  // message is worse than one that quietly answers from the catalog.
  ASSISTANT_PROVIDER: z.enum(['kb', 'llm']).default('kb'),
  ASSISTANT_LLM_API_KEY: z.string().min(1).optional(),
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
