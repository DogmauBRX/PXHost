import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { canActOnRole, canAssignRole } from '../admin/admin-permissions';
import { ListUsersDto } from './dto/list-users.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// The exact shape safe to ever put on the wire — never passwordHash,
// totpSecretEnc, or recoveryCodesEnc. Every method below selects exactly
// this, the same discipline `list()` already established.
const SAFE_SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  globalRole: true,
  isActive: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  totpEnabledAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read-only customer directory for the admin panel.
   *
   * Two things here are load-bearing rather than stylistic:
   *
   * 1. The `select` is explicit and always must be. The User model carries
   *    `passwordHash`, `totpSecretEnc` and `recoveryCodesEnc` — a bare
   *    `findMany()` would put credential material on the wire. Nothing in
   *    this file may switch to `include` or a spread of the whole row.
   *
   * 2. The whole query runs inside `withRLS` even though `users` itself has
   *    no RLS policy. The `ownedServers` count sub-select reaches into
   *    `servers`, which DOES — and outside an admin RLS context that count
   *    comes back 0 for everyone, silently. See PrismaService's doc comment.
   *
   * `email` and `username` are citext columns, so `contains` is already
   * case-insensitive at the database level; no `mode: 'insensitive'` needed.
   */
  async list(query: ListUsersDto) {
    const take = query.limit ?? 50;
    const skip = query.offset ?? 0;

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.role ? { globalRole: query.role } : {}),
      ...(query.q
        ? { OR: [{ email: { contains: query.q } }, { username: { contains: query.q } }] }
        : {}),
    };

    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: { ...SAFE_SELECT, _count: { select: { ownedServers: true } } },
        }),
        tx.user.count({ where }),
      ]);

      return {
        items: rows.map(({ _count, totpEnabledAt, ...user }) => ({
          ...user,
          serverCount: _count.ownedServers,
          // Expose only whether 2FA is on, never the enrolment timestamp's
          // underlying secret material.
          twoFactorEnabled: totpEnabledAt !== null,
        })),
        total,
        limit: take,
        offset: skip,
      };
    });
  }

  private async findActiveByEmailOrUsername(email: string, username: string) {
    return this.prisma.user.findFirst({
      where: { deletedAt: null, OR: [{ email }, { username }] },
      select: { id: true },
    });
  }

  /**
   * `dto.globalRole` (defaulting to `'user'`) is being ASSIGNED, not acted
   * on — there is no existing target row to rank-check against yet, so
   * the only hierarchy question here is whether the actor may hand out
   * that role at all (`canAssignRole`), the same check `update()` applies
   * when a role is part of the diff.
   */
  async create(dto: CreateUserDto, actor: AuthenticatedUser) {
    const roleToAssign = dto.globalRole ?? 'user';
    if (!canAssignRole(actor.globalRole, roleToAssign)) {
      throw new ForbiddenException(`Cannot create a user with role "${roleToAssign}"`);
    }

    const existing = await this.findActiveByEmailOrUsername(dto.email, dto.username);
    if (existing) throw new ConflictException('A user with that email or username already exists');

    const passwordHash = await this.password.hash(dto.password);
    const created = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        globalRole: roleToAssign,
      },
      select: SAFE_SELECT,
    });

    await this.audit.record({
      action: 'admin.user.create',
      actorId: actor.id,
      targetType: 'user',
      targetId: created.id,
      metadata: { email: created.email, username: created.username, globalRole: created.globalRole },
    });
    return { ...created, serverCount: 0, twoFactorEnabled: false };
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, globalRole: true } });
    if (!target) throw new NotFoundException('User not found');

    // Rank checks (client account management plan, Fase 1): an actor may
    // only touch a strictly-lower-ranked target, may only assign a role
    // <= their own rank, and may never change their OWN role — the same
    // reasoning as the self-block refusal in setActive() below, applied
    // to the more powerful "become someone else's rank" action.
    if (id === actor.id) {
      if (dto.globalRole !== undefined) throw new ConflictException('You cannot change your own role');
    } else if (!canActOnRole(actor.globalRole, target.globalRole)) {
      throw new ForbiddenException('Cannot modify a user of equal or higher rank');
    }
    if (dto.globalRole !== undefined && !canAssignRole(actor.globalRole, dto.globalRole)) {
      throw new ForbiddenException(`Cannot assign role "${dto.globalRole}"`);
    }

    if (dto.email || dto.username) {
      const clash = await this.prisma.user.findFirst({
        where: {
          deletedAt: null,
          id: { not: id },
          OR: [...(dto.email ? [{ email: dto.email }] : []), ...(dto.username ? [{ username: dto.username }] : [])],
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException('A user with that email or username already exists');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        email: dto.email,
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
        globalRole: dto.globalRole,
      },
      select: { ...SAFE_SELECT, _count: { select: { ownedServers: true } } },
    });

    // An explicit key allow-list, never a spread of the raw DTO — this
    // table is append-only with DELETE revoked from the app role
    // (migrations/0002_rls_policies), so any field ever added to
    // UpdateUserDto that shouldn't live there forever (a password, a
    // token) would otherwise be permanent the moment it's added.
    await this.audit.record({
      action: 'admin.user.update',
      actorId: actor.id,
      targetType: 'user',
      targetId: id,
      metadata: {
        email: dto.email,
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
        globalRole: dto.globalRole,
      },
    });
    const { _count, totpEnabledAt, ...rest } = updated;
    return { ...rest, serverCount: _count.ownedServers, twoFactorEnabled: totpEnabledAt !== null };
  }

  /**
   * Blocking takes effect on the user's VERY NEXT request, no token
   * invalidation needed: JwtAuthGuard re-checks `isActive` fresh from the
   * database on every single request (never trusted from the JWT), so an
   * already-issued access token stops working the instant this commits.
   */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, globalRole: true } });
    if (!target) throw new NotFoundException('User not found');
    if (id === actor.id) {
      if (!isActive) throw new ConflictException('You cannot block your own account');
    } else if (!canActOnRole(actor.globalRole, target.globalRole)) {
      throw new ForbiddenException('Cannot modify a user of equal or higher rank');
    }

    await this.prisma.user.update({ where: { id }, data: { isActive } });
    await this.audit.record({ action: isActive ? 'admin.user.unblock' : 'admin.user.block', actorId: actor.id, targetType: 'user', targetId: id });
  }
}
