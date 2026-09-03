// Pure module, no Nest DI — deliberately separate from `permission_catalog`
// (prisma/seed.ts), which is hardcoded `scope: 'server'` and drives the
// per-server subuser picker. Admin-panel permissions are a different axis
// entirely (who may manage CUSTOMER ACCOUNTS, not who may act on one
// customer's own server) and belong in their own in-code catalog, not
// mixed into that UI's data.

/** Mirrors the `users_global_role_check` CHECK constraint (0001_init) — the same closed set `ListUsersDto`/`CreateUserDto`/`UpdateUserDto` already validate against. */
export const ROLE_RANK: Record<string, number> = {
  user: 0,
  support: 1,
  admin: 2,
  root_admin: 3,
};

export const ADMIN_PERMISSIONS = [
  'clients.view',
  'clients.create',
  'clients.update',
  'clients.disable',
  'clients.password.reset',
  'clients.support',
  // Gates editing `adminPermissions` itself — deliberately its own key,
  // defaulted to root_admin only, so granting someone `clients.*` never
  // also hands them the ability to grant permissions to others.
  'admin.permissions.manage',
  // Capacity plan Fase 3 — infrastructure surface, deliberately its own
  // vocabulary rather than reusing `clients.*`: these gate NODES/PLANS/
  // CAPACITY/SERVERS (who may see or touch physical infrastructure and
  // commercial capacity), a different axis from `clients.*` (who may
  // act on a CUSTOMER's account). One `.manage`/`.view` pair per
  // resource — no `clients.manage` was ever introduced for the same
  // reason (`clients.*` already exists at per-action granularity); these
  // four resources start simpler and can split further later without a
  // migration, since permission keys are plain strings, not columns.
  'nodes.view',
  'nodes.manage',
  'plans.view',
  'plans.manage',
  'capacity.view',
  'capacity.manage',
  'servers.view',
  'servers.manage',
  // Commercial site (subscriptions plan) — who may see/manage customer
  // subscriptions in /admin/subscriptions. Its own vocabulary for the
  // same reason `nodes.*`/`plans.*`/`capacity.*`/`servers.*` are: a
  // subscription is neither "a customer account" (clients.*) nor
  // "infrastructure" (nodes/capacity), it's the commercial contract
  // between the two.
  'subscriptions.view',
  'subscriptions.manage',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Role-derived defaults. `adminPermissions` (the DB column) is ADDITIVE
 * over these, never subtractive — an empty column array reproduces
 * exactly today's behaviour (AdminGuard's coarse `isAdmin` check), so
 * this table is safe to introduce with no backfill and no lockout risk.
 *
 * `support`'s default is the direct fix for a real hole: today `support`
 * can PATCH any user's `globalRole` to `root_admin` because `AdminGuard`
 * only checks the coarse `isAdmin` bit. `support` gets read access and
 * the ability to look up account state for a support call, nothing that
 * mutates an account.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<string, readonly (AdminPermission | '*')[]> = {
  root_admin: ['*'],
  // 🔴 `admin` is a literal list, not `'*'` — every one of the keys
  // added above (capacity plan Fase 3's 8, plus the commercial site's
  // subscriptions.*) MUST appear here, in the SAME commit as any route
  // that gets decorated with one, or that route disappears from every
  // existing `admin` the instant the decorator lands (see the capacity
  // plan's own explicit warning about this exact failure mode).
  admin: [
    'clients.view',
    'clients.create',
    'clients.update',
    'clients.disable',
    'clients.password.reset',
    'clients.support',
    'nodes.view',
    'nodes.manage',
    'plans.view',
    'plans.manage',
    'capacity.view',
    'capacity.manage',
    'servers.view',
    'servers.manage',
    'subscriptions.view',
    'subscriptions.manage',
  ],
  // The five `.view` keys preserve `support`'s CURRENT behavior — it
  // already passes AdminGuard and already reads nodes/plans/capacity/
  // servers with no finer gate today, and a support rep fielding "why
  // hasn't my plan activated" needs to at least SEE the subscription —
  // this is not a grant of new mutation access, only read access
  // matching what every other resource here already gives `support`.
  support: ['clients.view', 'clients.support', 'nodes.view', 'plans.view', 'capacity.view', 'servers.view', 'subscriptions.view'],
  user: [],
};

/** The set of admin permission keys this role+column combination actually grants. `'*'` in either the role default or the raw column means everything. */
export function resolveAdminPermissions(globalRole: string, granted: string[]): Set<AdminPermission> | '*' {
  const roleDefaults = ROLE_DEFAULT_PERMISSIONS[globalRole] ?? [];
  if (roleDefaults.includes('*') || granted.includes('*')) return '*';
  return new Set([...roleDefaults, ...granted] as AdminPermission[]);
}

export function hasAdminPermission(globalRole: string, granted: string[], key: AdminPermission): boolean {
  const resolved = resolveAdminPermissions(globalRole, granted);
  return resolved === '*' || resolved.has(key);
}

/**
 * Hierarchy rule for every user-management mutation (client account
 * management plan, Fase 1): an actor may only act on a target of
 * STRICTLY lower rank. This is independent of `adminPermissions` — it
 * closes lateral compromise between peers (an `admin` resetting another
 * `admin`'s password) and escalation (`support` promoting someone to
 * `root_admin`), neither of which a permission string alone prevents,
 * since both actors could hold the identical permission key.
 */
export function canActOnRole(actorRole: string, targetRole: string): boolean {
  return (ROLE_RANK[actorRole] ?? -1) > (ROLE_RANK[targetRole] ?? -1);
}

/** An actor may only assign a role of rank <= their own — never grant someone a higher seat than they themselves hold. */
export function canAssignRole(actorRole: string, roleToAssign: string): boolean {
  return (ROLE_RANK[roleToAssign] ?? Infinity) <= (ROLE_RANK[actorRole] ?? -1);
}
