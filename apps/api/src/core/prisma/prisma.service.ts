import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export interface RlsContext {
  userId: string | null;
  isAdmin: boolean;
}

/**
 * PrismaService is the only place in the codebase that talks to Postgres.
 *
 * `DATABASE_URL` (see .env) connects as `app_user`, the same
 * RLS-restricted role used everywhere in this process — there is no
 * separate superuser connection here (that's what `DIRECT_DATABASE_URL`,
 * used only by `prisma migrate`, is for). Two request paths exist,
 * deliberately:
 *
 *  - Direct use of `this.<model>` runs with NO `app.user_id`/`app.is_admin`
 *    session variables set. On a table with an RLS policy, `current_setting`
 *    then reads as unset/false and the policy denies everything — a plain
 *    `this.server.findMany(...)` silently returns zero rows, it does not
 *    error and does not bypass anything. This is only safe for tables that
 *    have NO RLS policy at all (the global catalog: `users`, `nodes`,
 *    `plans`, `server_templates`, `locations`, `template_groups`, ...) —
 *    confirmed real bugs (M5) from assuming otherwise: an admin-guarded
 *    in-use check (`server.count()` before deleting a plan/node/template)
 *    and the agent's install-completed callback (`server.findFirst()`)
 *    both silently saw zero rows and mis-behaved, on RLS-protected `servers`.
 *  - `withRLS(ctx, fn)` runs `fn` inside a transaction with
 *    `app.user_id` / `app.is_admin` set via `SET LOCAL`, which the RLS
 *    policies (see prisma/migrations/*_rls.sql) read via
 *    `current_setting('app.user_id', true)`. Every read OR write touching
 *    a tenant table (`servers`, `allocations`, `server_variables`,
 *    `subusers`, `backups`, ...) — even one already authorized by a guard —
 *    MUST go through this. It is the backstop described in architecture
 *    doc 2.4: even a forgotten `WHERE owner_id = ?` returns zero rows
 *    instead of another customer's data — but that backstop applies
 *    just as unforgivingly to code that forgot to set admin context.
 *
 * `SET LOCAL` only applies to the current transaction, which is exactly
 * the isolation we want — it can never leak across requests sharing a
 * pooled connection.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withRLS<T>(ctx: RlsContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterized via Prisma.sql to avoid any risk of SQL injection
      // through userId — though it's always a UUID from a verified JWT,
      // never raw user input, defense in depth costs nothing here.
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
      await tx.$executeRaw`SELECT set_config('app.is_admin', ${ctx.isAdmin ? 'on' : 'off'}, true)`;
      return fn(tx);
    });
  }
}
