import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { AuditService } from '../audit/audit.service';
import { UpdateAccountDto, ChangePasswordDto } from './dto/account.dto';

// Same discipline as UsersService.SAFE_SELECT (users.service.ts) — never
// passwordHash/totpSecretEnc/recoveryCodesEnc. language/timezone are
// deliberately excluded from BOTH this select and UpdateAccountDto: real
// columns, but nothing in this app reads or branches on them today
// (the only "timezone" anywhere else is Schedule.timezone, an unrelated
// per-schedule field) — surfacing them as editable would be exactly the
// "field just to fill the screen" the feature request explicitly warns
// against.
const ACCOUNT_SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  globalRole: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  totpEnabledAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly audit: AuditService,
  ) {}

  private async toDto(record: { totpEnabledAt: Date | null } & Record<string, unknown>) {
    const { totpEnabledAt, ...rest } = record;
    return { ...rest, twoFactorEnabled: totpEnabledAt !== null };
  }

  async getProfile(userId: string) {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: ACCOUNT_SELECT });
    return this.toDto(record);
  }

  /**
   * Same email/username uniqueness check as UsersService.update
   * (users.service.ts:158-168), copied rather than shared across modules
   * for a 3-line query — not worth a cross-module dependency. Changing
   * email additionally requires `currentPassword` (design decision #2 in
   * the plan) and resets `emailVerifiedAt` to null: no email-verification
   * system exists in this codebase (deliberately not building one — see
   * the plan), so leaving it stale-true after a silent email swap would
   * misrepresent that the NEW address was ever confirmed.
   */
  async updateProfile(userId: string, dto: UpdateAccountDto) {
    if (dto.email !== undefined) {
      if (!dto.currentPassword) {
        throw new BadRequestException('currentPassword is required to change email');
      }
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
      const valid = await this.password.verify(user.passwordHash, dto.currentPassword);
      if (!valid) throw new UnauthorizedException('Current password is incorrect');
    }

    if (dto.email || dto.username) {
      const clash = await this.prisma.user.findFirst({
        where: {
          deletedAt: null,
          id: { not: userId },
          OR: [...(dto.email ? [{ email: dto.email }] : []), ...(dto.username ? [{ username: dto.username }] : [])],
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException('A user with that email or username already exists');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        username: dto.username,
        email: dto.email,
        emailVerifiedAt: dto.email !== undefined ? null : undefined,
      },
      select: ACCOUNT_SELECT,
    });

    // Explicit allow-list, never a spread of the raw DTO — same reasoning
    // as UsersService.update's own comment: audit_logs is append-only, so
    // any field ever added to this DTO that shouldn't live there forever
    // (currentPassword, obviously) would otherwise be permanent.
    await this.audit.record({
      action: 'account.update',
      actorId: userId,
      targetType: 'user',
      targetId: userId,
      metadata: { firstName: dto.firstName, lastName: dto.lastName, username: dto.username, email: dto.email },
    });

    return this.toDto(updated);
  }

  /**
   * Verifies currentPassword, then reuses SessionRevocationService
   * .revokeAllForUser — its 'password_reset' reason was already reserved
   * for exactly this, just never called until now. Consequence: the
   * CALLER's own access token is invalidated on its very next use too
   * (tokensValidAfter is bumped to now()), which is correct — the panel
   * treats a successful response here as an auto-logout.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ revokedSessions: number }> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('newPassword and confirmPassword must match');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    const valid = await this.password.verify(user.passwordHash, dto.currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await this.password.hash(dto.newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    const { revokedSessions } = await this.sessionRevocation.revokeAllForUser(userId, 'password_reset');
    await this.audit.record({
      action: 'account.password.change',
      actorId: userId,
      targetType: 'user',
      targetId: userId,
      metadata: { revokedSessions },
    });

    return { revokedSessions };
  }
}
