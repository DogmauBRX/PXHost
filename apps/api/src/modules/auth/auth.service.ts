import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; email: string; username: string; globalRole: string };
}

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, plainPassword: string, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    });

    if (!user) {
      // Uniform-timing dummy verify: an unknown email must cost roughly
      // the same wall-clock time as a known one with a wrong password,
      // or the response latency itself becomes an account-enumeration
      // oracle (architecture doc 3.3).
      await this.password.dummyVerify();
      await this.audit.record({
        action: 'auth.login.failed',
        actorEmail: email,
        actorIp: meta.ip,
        metadata: { reason: 'no_such_user' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        actorIp: meta.ip,
        metadata: { reason: 'locked' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.password.verify(user.passwordHash, plainPassword);
    if (!valid) {
      await this.registerFailedLogin(user.id, user.failedLogins);
      await this.audit.record({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        actorIp: meta.ip,
        metadata: { reason: 'bad_password' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      await this.audit.record({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        actorIp: meta.ip,
        metadata: { reason: 'inactive' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // Rehash-on-drift: if the stored hash's params no longer match the
    // service's current tuning, upgrade it transparently on this
    // successful login (architecture doc 3.3).
    const updates: Record<string, unknown> = {
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    };
    if (this.password.needsRehash(user.passwordHash)) {
      updates.passwordHash = await this.password.hash(plainPassword);
    }
    await this.prisma.user.update({ where: { id: user.id }, data: updates });

    const result = await this.issueSession(user.id, user.globalRole !== 'user', meta);

    await this.audit.record({
      action: 'auth.login.success',
      actorId: user.id,
      actorEmail: user.email,
      actorIp: meta.ip,
    });

    return {
      ...result,
      user: { id: user.id, email: user.email, username: user.username, globalRole: user.globalRole },
    };
  }

  /**
   * Refresh-token rotation with reuse detection (architecture doc 3.2).
   * Every call issues a brand-new refresh token and marks the presented
   * one used. If a token is presented a SECOND time, that is proof of
   * theft (a legitimate client never reuses a rotated-out token): the
   * entire family is revoked, forcing a fresh login everywhere.
   */
  async refresh(presentedToken: string, meta: RequestMeta): Promise<LoginResult> {
    const hash = this.tokens.hashRefreshToken(presentedToken);
    const session = await this.prisma.session.findFirst({ where: { refreshHash: hash } });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.usedAt || session.revokedAt) {
      await this.handleRefreshReuse(session.familyId, session.userId, meta);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }

    await this.prisma.session.update({ where: { id: session.id }, data: { usedAt: new Date() } });

    const result = await this.issueSession(user.id, user.globalRole !== 'user', meta, {
      familyId: session.familyId,
      parentId: session.id,
    });

    return {
      ...result,
      user: { id: user.id, email: user.email, username: user.username, globalRole: user.globalRole },
    };
  }

  async logout(sessionId: string, jti: string, allDevices: boolean, userId: string): Promise<void> {
    const accessTtl = this.config.get<number>('JWT_ACCESS_TTL_SECONDS')!;
    await this.redis.denylistJti(jti, accessTtl);
    await this.redis.denylistSession(sessionId, accessTtl);

    if (allDevices) {
      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: new Date() } });
    } else {
      await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
    }

    await this.audit.record({ action: 'auth.logout', actorId: userId, metadata: { allDevices } });
  }

  private async handleRefreshReuse(familyId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: new Date() } });
    await this.audit.record({
      action: 'auth.refresh_reuse',
      actorId: userId,
      actorIp: meta.ip,
      metadata: { familyId },
    });
  }

  private async registerFailedLogin(userId: string, currentFailures: number): Promise<void> {
    const next = currentFailures + 1;
    const data: Record<string, unknown> = { failedLogins: next };
    if (next >= MAX_FAILED_LOGINS) {
      data.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
    }
    await this.prisma.user.update({ where: { id: userId }, data });
  }

  private async issueSession(
    userId: string,
    isAdmin: boolean,
    meta: RequestMeta,
    rotateFrom?: { familyId: string; parentId: string },
  ): Promise<Omit<LoginResult, 'user'>> {
    const refresh = this.tokens.generateRefreshToken();
    const refreshTtl = this.tokens.refreshTtlSeconds();
    const expiresAt = new Date(Date.now() + refreshTtl * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshHash: refresh.hash,
        familyId: rotateFrom?.familyId, // undefined -> DB default (uuidv7()) mints a new family
        parentId: rotateFrom?.parentId,
        userAgent: meta.userAgent ?? undefined,
        ip: meta.ip ?? undefined,
        expiresAt,
      },
    });

    const access = this.tokens.signAccessToken({ userId, sessionId: session.id, isAdmin });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresAt: expiresAt,
    };
  }
}
