import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';

const PERM_CACHE_TTL_SECONDS = 60; // architecture doc 2.5: "perm:{user}:{server}, 60s TTL, invalidated on subuser/suspension/role change"

// Architecture doc 2.5's gating table, literally: "suspended blocks
// control.*, file writes, backup create/restore, DB writes, schedules,
// SFTP | allows reads, backup download, admin unsuspend." Encoded as a
// consistent rule rather than an enumerated list per permission: any
// `.read` key always passes (covers "reads" + "backup download," which
// IS backup.read — there's no separate download permission); `schedule.*`
// is blocked wholesale by its OWN key prefix; the specific mutating keys
// the table calls out by name for control/file/backup/database are
// blocked individually — NOT by prefix-matching "control", because
// `websocket.connect` is itself a member of the `control` permission
// GROUP (prisma/seed.ts's PERMISSION_CATALOG groupKey) despite its own
// key text starting with "websocket", not "control" — found live
// testing this exact milestone: a suspended server's minted console
// token still carried `websocket.connect` because a prefix check can
// never catch a key whose own text disagrees with its catalog group.
// Everything else (user.*, activity.read, backup.delete — the table
// doesn't mention backup deletion at all) is unaffected by suspension.
// "admin unsuspend" isn't a customer permission key, so it has no entry
// here — ServersController's admin routes go through AdminGuard, not
// this closure, at all.
const SUSPENDED_BLOCKED_KEYS = [
  'websocket.connect',
  'control.console',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'file.write',
  'file.delete',
  'backup.create',
  'backup.restore',
  'database.create',
  'database.delete',
];

function allowedWhenSuspended(status: string, permission: string): boolean {
  if (status !== 'suspended') return true;
  if (permission.endsWith('.read')) return true;
  if (permission.startsWith('schedule.')) return false;
  return !SUSPENDED_BLOCKED_KEYS.includes(permission);
}

function fetchOwned(tx: Prisma.TransactionClient, serverId: string) {
  return tx.server.findFirst({
    where: { id: serverId },
    include: {
      node: { select: { id: true, name: true, fqdn: true, scheme: true, daemonPort: true } },
      template: { select: { id: true, name: true } },
      plan: { select: { id: true, name: true } },
      allocations: { select: { ip: true, port: true, isPrimary: true } },
    },
  });
}

export interface ResolvedAccess {
  server: NonNullable<Awaited<ReturnType<typeof fetchOwned>>>;
  role: 'owner' | 'subuser';
  /** true for every permission key when role is 'owner' — ownership is the superset, never itself a stored permission list (architecture doc 2.5). */
  can(permission: string): boolean;
}

/**
 * The single chokepoint every client-facing server route goes through
 * (architecture doc 5.1). `resolve` runs under `withRLS` with the
 * CALLER's own (non-admin) context — the `servers_tenant` RLS policy
 * (`can_access_server`) is what actually decides owner-or-accepted-subuser
 * access, so a route can never accidentally see another customer's server
 * just because a `WHERE owner_id = ?` was forgotten here. A non-owner
 * (or a server that doesn't exist at all) gets the identical 404 either
 * way — resolve() never confirms existence to someone who can't see it.
 *
 * `resolve()` additionally answers the SECOND question RLS deliberately
 * leaves open — "can access the server at all" vs "can do THIS specific
 * thing on it" (architecture doc 2.5's two-axis RBAC) — by resolving the
 * caller's permission set (all of them, for the owner; whatever
 * `subusers.permissions` grants, for anyone else) and handing back a
 * `can()` closure every mutating route calls before doing anything.
 */
@Injectable()
export class ServerAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async resolve(userId: string, serverId: string): Promise<ResolvedAccess> {
    const server = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => fetchOwned(tx, serverId));
    if (!server) throw new NotFoundException('Server not found');

    // Resolution order (architecture doc 2.5, fixed & short-circuiting):
    // ... -> permission key -> server status gate -> ... — the status
    // gate applies AFTER the permission-key check and to EVERY role,
    // owner included: ownership answers "can you touch this server at
    // all," not "does this server's current status allow this specific
    // action right now." allowedWhenSuspended is what actually encodes
    // the gating table's own split (reads/backup-download always pass;
    // control/schedule/mutating-write actions don't).
    if (server.ownerId === userId) {
      return { server, role: 'owner', can: (permission: string) => allowedWhenSuspended(server.status, permission) };
    }

    const permissions = await this.resolveSubuserPermissions(userId, serverId);
    return {
      server,
      role: 'subuser',
      can: (permission: string) => permissions.includes(permission) && allowedWhenSuspended(server.status, permission),
    };
  }

  async listAccessible(userId: string) {
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.server.findMany({
        // can_access_server already scopes every row this RLS-connected
        // query can see to "owned OR accepted-subuser-of" — no need to
        // repeat that filter in the WHERE clause, and repeating it with
        // an OR on subusers here would just be a slower, redundant
        // reimplementation of the same check the database already makes.
        orderBy: { createdAt: 'desc' },
        include: { node: { select: { id: true, name: true } }, plan: { select: { id: true, name: true } } },
      }),
    );
  }

  /** Called by SubusersService after any invite/permission-update/removal — the 60s TTL alone would eventually self-correct, but a permission REVOKED should never still work for up to a minute. */
  async invalidatePermissionCache(userId: string, serverId: string): Promise<void> {
    await this.redis.client.del(this.permCacheKey(userId, serverId));
  }

  private async resolveSubuserPermissions(userId: string, serverId: string): Promise<string[]> {
    const cacheKey = this.permCacheKey(userId, serverId);
    const cached = await this.redis.client.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as string[];

    const subuser = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subuser.findFirst({ where: { serverId, userId, acceptedAt: { not: null } }, select: { permissions: true } }),
    );
    const permissions = subuser?.permissions ?? [];
    await this.redis.client.set(cacheKey, JSON.stringify(permissions), 'EX', PERM_CACHE_TTL_SECONDS);
    return permissions;
  }

  private permCacheKey(userId: string, serverId: string): string {
    return `perm:${userId}:${serverId}`;
  }
}
