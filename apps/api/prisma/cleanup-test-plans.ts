// Safe cleanup for the plan fixtures the e2e suite leaves behind.
//
// Why this exists: on 2026-09-11 a single ad-hoc `UPDATE plans SET
// deleted_at = now()` run directly against the dev database — with no
// scope at all — soft-deleted 1130 rows in one shot, including the six
// REAL catalog plans (Básico, Intermediário, Avançado and their
// -trimestral siblings). Nothing in the committed test suite did this
// (every spec's own afterAll scopes its cleanup by an explicit id/list
// of ids); it was a manual command that forgot to filter. This script
// exists so "clean up the test plans" never again means typing a raw
// UPDATE by hand.
//
// Usage:
//   pnpm --dir apps/api run cleanup:test-plans            # dry run — prints what WOULD happen
//   pnpm --dir apps/api run cleanup:test-plans -- --apply # actually soft-deletes
//
// Safety properties, in order of how much they matter:
//   1. Refuses outright if NODE_ENV=production. This script has no
//      legitimate reason to ever touch a production database.
//   2. Dry-run by default — nothing is written unless `--apply` is
//      passed explicitly. The report is meant to be read before that.
//   3. A hard-coded PROTECTED_SLUGS denylist — the real catalog — is
//      excluded from candidates regardless of whether the pattern below
//      would have matched them. If a protected slug ever DOES match,
//      that's printed loudly as something to investigate, not silently
//      swallowed.
//   4. The pattern is deliberately NARROW, not broad: it looks for the
//      literal test-naming conventions every e2e spec actually uses
//      (verified against every `apps/api/test/*.e2e-spec.ts` file that
//      creates a Plan, 2026-09) — either the substring "e2e", or a
//      slug/name ending in a long embedded Unix-ms timestamp
//      (`${suffix}`, always Date.now(), 13 digits, sometimes with a
//      trailing "-N" index). A real, human-named plan essentially never
//      matches either. If a future spec invents a naming convention
//      that matches neither, this script will not touch it — that's
//      the intended failure mode (miss a fixture, never a real plan).
//   5. Before soft-deleting a candidate, it re-checks for live
//      servers/subscriptions/orders referencing it and SKIPS (never
//      forces) any that have some — a plan matching the naming pattern
//      should never legitimately have real usage, so this only ever
//      fires if something is unexpectedly wrong, and it's better to
//      stop and say so.
//   6. The actual write is `updateMany({ where: { id: { in: [...] } } })`
//      — an explicit list of ids gathered by a SEPARATE read step, never
//      a single broad WHERE clause executed directly. This is the one
//      property the incident on 2026-09-11 didn't have.
//   7. Only ever soft-deletes (`deletedAt`), exactly like
//      `PlansService.remove` does — never a hard DELETE.
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();

// The real commercial catalog, as of 2026-09 (apps/api/prisma/seed.ts's
// own slugs, plus the -trimestral siblings created afterward through
// the admin panel for the billing-cycle feature). Never touched by this
// script, no matter what the pattern below says.
const PROTECTED_SLUGS = ['basico', 'basico-trimestral', 'medio', 'medio-trimestral', 'avancado', 'avancado-trimestral'];

const PUBLIC_PLANS_CACHE_KEY = 'public:plans:v1';

interface Candidate {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Recusado: NODE_ENV=production. Este script nunca deve rodar contra produção.');
    process.exitCode = 1;
    return;
  }

  const apply = process.argv.includes('--apply');

  // Raw SQL for the pattern match only — Prisma's query builder has no
  // portable regex operator. The WRITE below never uses this WHERE
  // directly; it only feeds an explicit id list into a second,
  // narrowly-scoped statement.
  const candidates = await prisma.$queryRaw<Candidate[]>`
    SELECT id, name, slug, created_at AS "createdAt"
    FROM plans
    WHERE deleted_at IS NULL
      AND (
        name ~* 'e2e' OR slug ~* 'e2e'
        OR name ~ '-[0-9]{10,}(-[0-9]+)?$'
        OR slug ~ '-[0-9]{10,}(-[0-9]+)?$'
      )
    ORDER BY created_at ASC
  `;

  const protectedMatches = candidates.filter((c) => PROTECTED_SLUGS.includes(c.slug));
  if (protectedMatches.length > 0) {
    console.warn('⚠ ATENÇÃO: os seguintes planos PROTEGIDOS bateram no padrão de teste — algo está errado, investigue antes de continuar:');
    for (const p of protectedMatches) console.warn(`  - ${p.name} (${p.slug})`);
  }
  const toConsider = candidates.filter((c) => !PROTECTED_SLUGS.includes(c.slug));

  if (toConsider.length === 0) {
    console.log('Nenhum plano de teste encontrado. Nada a fazer.');
    return;
  }

  const toDelete: Candidate[] = [];
  const skippedInUse: { plan: Candidate; servers: number; subscriptions: number; orders: number }[] = [];

  for (const plan of toConsider) {
    const [servers, subscriptions, orders] = await Promise.all([
      prisma.server.count({ where: { planId: plan.id } }),
      prisma.subscription.count({ where: { planId: plan.id } }),
      prisma.order.count({ where: { planId: plan.id } }),
    ]);
    if (servers > 0 || subscriptions > 0 || orders > 0) {
      skippedInUse.push({ plan, servers, subscriptions, orders });
    } else {
      toDelete.push(plan);
    }
  }

  console.log(`${apply ? 'Aplicando' : '[dry run] Simulando'} limpeza de planos de teste:`);
  console.log(`  ${toDelete.length} plano(s) serão soft-deletados (nenhuma referência viva encontrada)`);
  for (const p of toDelete.slice(0, 10)) console.log(`    - ${p.name} (${p.slug})`);
  if (toDelete.length > 10) console.log(`    ... e mais ${toDelete.length - 10}`);

  if (skippedInUse.length > 0) {
    console.log(`  ${skippedInUse.length} plano(s) IGNORADOS por terem referência viva (não deveria acontecer para um fixture de teste — revise manualmente):`);
    for (const s of skippedInUse) {
      console.log(`    - ${s.plan.name} (${s.plan.slug}): servers=${s.servers} subscriptions=${s.subscriptions} orders=${s.orders}`);
    }
  }

  if (!apply) {
    console.log('\nNada foi alterado (dry run). Rode novamente com `-- --apply` para aplicar.');
    return;
  }

  if (toDelete.length > 0) {
    const result = await prisma.plan.updateMany({
      where: { id: { in: toDelete.map((p) => p.id) } },
      data: { deletedAt: new Date() },
    });
    console.log(`\n${result.count} plano(s) soft-deletado(s).`);
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      await redis.del(PUBLIC_PLANS_CACHE_KEY);
      console.log('Cache do catálogo público invalidado.');
    } catch (err) {
      console.warn(`Não foi possível invalidar o cache do catálogo (não crítico — expira em até 30s sozinho): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      redis.disconnect();
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
