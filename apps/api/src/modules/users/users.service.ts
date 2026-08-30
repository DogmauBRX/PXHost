import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ListUsersDto } from './dto/list-users.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
          select: {
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
            _count: { select: { ownedServers: true } },
          },
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
}
