import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Why the revocation happened — carried through so a caller's audit entry can explain itself without re-deriving the reason. */
export type RevocationReason = 'logout_all' | 'password_reset' | 'admin_soft_delete' | 'trial_expired';

export interface RevocationResult {
  revokedSessions: number;
  tokensValidAfter: Date;
}

/**
 * The single definition of "kill every session this user has, right now."
 * Extracted out of AuthService.logout's `allDevices` branch (client
 * account management plan, Fase 1) because every admin-initiated action
 * that must revoke a TARGET user's sessions — password reset, soft
 * delete, trial expiry — has no `sessionId`/`jti` for that target the way
 * a self-service logout does, and attributing an `auth.logout` audit row
 * to the target when the admin did it would be a lie.
 *
 * Deliberately does NOT touch the Redis jti/session denylist
 * (`RedisService.denylistJti`/`denylistSession`): those are per-token,
 * and the caller here never has the target's specific token identifiers.
 * `tokensValidAfter` is exactly the belt-and-suspenders mechanism
 * `jwt-auth.guard.ts`'s doc comment describes for this case — a token
 * minted before this timestamp is rejected on its very next use,
 * independent of any denylist entry.
 *
 * Deliberately does NOT write an audit row — the caller audits under its
 * own action name (`admin.user.password.reset`, `admin.user.delete`,
 * ...) with `revokedSessions` folded into its own metadata, so there is
 * one audit entry per admin action, not two.
 */
@Injectable()
export class SessionRevocationService {
  constructor(private readonly prisma: PrismaService) {}

  async revokeAllForUser(userId: string, _reason: RevocationReason): Promise<RevocationResult> {
    const tokensValidAfter = new Date();
    const [{ count }] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: tokensValidAfter },
      }),
      this.prisma.user.update({ where: { id: userId }, data: { tokensValidAfter } }),
    ]);
    return { revokedSessions: count, tokensValidAfter };
  }
}
