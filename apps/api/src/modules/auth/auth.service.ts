import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { MailService } from '../../core/mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { SessionRevocationService } from './session-revocation.service';

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

// Client account management, Fase 1 — password-reset token. Same shape as
// NodeBootstrapService's bootstrap token (node-bootstrap.service.ts):
// Redis-only, single-use, stored by hash, burn-on-use. 60 min, a fixed
// constant rather than a new env var, matching BOOTSTRAP_TTL_SECONDS's
// own hardcoded style — this isn't operator-tunable infra, just a
// reasonable default.
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

// Rate limiting has no framework in this codebase (no @nestjs/throttler)
// — same hand-rolled INCR+EXPIRE scheme AssistantService.checkRateLimit
// already uses. Two independent counters: per-email catches someone
// hammering one account, per-IP catches spraying many addresses from one
// source.
const RESET_REQUEST_WINDOW_SECONDS = 60 * 60;
const RESET_REQUEST_LIMIT_PER_EMAIL = 5;
const RESET_REQUEST_LIMIT_PER_IP = 20;

// Commercial site — public self-signup rate limits. Same hand-rolled
// INCR+EXPIRE scheme as the password-reset limiter just above, separate
// counters/prefix (a burst of signups from one IP is a different signal
// than a burst of reset requests, and must never share a bucket with it).
const REGISTER_WINDOW_SECONDS = 60 * 60;
const REGISTER_LIMIT_PER_EMAIL = 3;
const REGISTER_LIMIT_PER_IP = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly mail: MailService,
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
   * Commercial site — public self-signup. Refuses at USE time when the
   * feature isn't opted into (`ALLOW_PUBLIC_REGISTRATION`, default
   * false), the same posture `BillingWebhookService.verifySignature`
   * already established for an optional feature rather than gating it
   * only at the controller: a 404 here means "this deployment never
   * turned registration on," not "the route doesn't exist," and either
   * way an unauthenticated caller can't tell the difference.
   *
   * Unlike `login`'s anti-enumeration posture, a duplicate email here IS
   * reported as a real error — a signup form that silently "succeeds" on
   * an existing email, with no way to tell the visitor to log in
   * instead, is a worse product than the (much lower, since this
   * endpoint's very existence already announces public signup is on)
   * enumeration cost of confirming an email is taken. `UsersService
   * .create` (the admin-facing equivalent) makes the identical call.
   *
   * Issues a session immediately on success (mirrors `login`'s return
   * shape exactly) so the commercial checkout flow can go straight from
   * "create account" into "subscribe" without a second round trip.
   */
  async register(dto: { name: string; email: string; password: string; confirmPassword: string }, meta: RequestMeta): Promise<LoginResult> {
    if (!this.config.get<boolean>('ALLOW_PUBLIC_REGISTRATION')) {
      throw new NotFoundException('Not found');
    }
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('password and confirmPassword must match');
    }

    await this.checkRegisterRateLimit(dto.email, meta.ip);

    const email = dto.email.trim();
    const existing = await this.prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (existing) throw new ConflictException('A user with that email already exists');

    const username = await this.generateUniqueUsername(email);
    const passwordHash = await this.password.hash(dto.password);

    const user = await this.prisma.user.create({
      data: { email, username, passwordHash, firstName: dto.name.trim(), globalRole: 'user' },
    });

    const result = await this.issueSession(user.id, false, meta);

    await this.audit.record({
      action: 'auth.register',
      actorId: user.id,
      actorEmail: user.email,
      actorIp: meta.ip,
    });

    return {
      ...result,
      user: { id: user.id, email: user.email, username: user.username, globalRole: user.globalRole },
    };
  }

  private async checkRegisterRateLimit(email: string, ip: string | null | undefined): Promise<void> {
    const emailKey = `register_rl:email:${email.trim().toLowerCase()}`;
    const emailCount = await this.redis.client.incr(emailKey);
    if (emailCount === 1) await this.redis.client.expire(emailKey, REGISTER_WINDOW_SECONDS);

    let ipCount = 0;
    if (ip) {
      const ipKey = `register_rl:ip:${ip}`;
      ipCount = await this.redis.client.incr(ipKey);
      if (ipCount === 1) await this.redis.client.expire(ipKey, REGISTER_WINDOW_SECONDS);
    }

    if (emailCount > REGISTER_LIMIT_PER_EMAIL || ipCount > REGISTER_LIMIT_PER_IP) {
      throw new HttpException('Muitas tentativas de cadastro em pouco tempo — aguarde antes de tentar novamente.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Derives a username from the email's local part — the public signup
   * form never asks for one (commercial plan §8: "não pedir informações
   * desnecessárias"), unlike `CreateUserDto`, the admin-facing DTO, which
   * still requires an explicit one. Slugified to the same charset the
   * admin UI already accepts, then suffixed with an incrementing number
   * only if the slug collides — the common case (a fresh email) never
   * pays that extra query.
   */
  private async generateUniqueUsername(email: string): Promise<string> {
    const local = email.split('@')[0] ?? 'user';
    const base = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';

    for (let suffix = 0; suffix < 50; suffix++) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      const taken = await this.prisma.user.findFirst({ where: { username: candidate, deletedAt: null }, select: { id: true } });
      if (!taken) return candidate;
    }
    // Astronomically unlikely (50 collisions on the same slug) — fall
    // back to a random suffix rather than looping forever.
    return `${base}-${randomBytes(4).toString('hex')}`;
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
      await this.sessionRevocation.revokeAllForUser(userId, 'logout_all');
    } else {
      await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
    }

    await this.audit.record({ action: 'auth.logout', actorId: userId, metadata: { allDevices } });
  }

  /**
   * Client account management, Fase 1. Always returns — never throws for
   * "no such user," never lets the caller distinguish that case from a
   * real one (architecture doc 3.3's anti-enumeration principle, same
   * posture `login`'s `dummyVerify` branch already applies). The rate
   * limit is checked first and can 429 either way — that's not an
   * enumeration vector, since the limiter's key is just the literal
   * string the caller already submitted.
   *
   * Critically, the email is sent WITHOUT awaiting `MailService` — an
   * SMTP round trip in the hot path would make response LATENCY the
   * enumeration oracle even with an identical response body. The Redis
   * `SET` before it is a sub-ms operation, so both the "user exists" and
   * "user doesn't" branches return in comparable time.
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    await this.checkResetRateLimit(email, meta.ip);

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    });
    if (!user) return;

    const token = `prt_${randomBytes(32).toString('base64url')}`;
    await this.redis.client.set(passwordResetRedisKey(token), user.id, 'EX', PASSWORD_RESET_TTL_SECONDS);

    const resetUrl = `${this.config.get<string>('PANEL_URL')}/reset-password?token=${token}`;
    void this.mail.sendPasswordResetEmail(user.email, resetUrl);

    await this.audit.record({
      action: 'auth.password_reset.requested',
      actorId: user.id,
      actorEmail: user.email,
      actorIp: meta.ip,
    });
  }

  /**
   * Redeems a password-reset token — GET then immediate DEL, the exact
   * burn-on-use shape NodeBootstrapService.bootstrap already established,
   * so a retried/duplicated request can't reuse one token twice racing
   * the delete. Completing a reset revokes every session the user has
   * (SessionRevocationService's `'password_reset'` reason, previously
   * unused anywhere) — this invalidates the token that authorized THIS
   * request too, which is correct: a reset should force a fresh login
   * everywhere, not just "everywhere else."
   */
  async resetPassword(token: string, newPassword: string, confirmPassword: string, meta: RequestMeta): Promise<void> {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('newPassword and confirmPassword must match');
    }

    const key = passwordResetRedisKey(token);
    const userId = await this.redis.client.get(key);
    if (!userId) throw new BadRequestException('Invalid or expired token');
    await this.redis.client.del(key);

    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new BadRequestException('Invalid or expired token');

    const passwordHash = await this.password.hash(newPassword);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });

    const { revokedSessions } = await this.sessionRevocation.revokeAllForUser(user.id, 'password_reset');
    await this.audit.record({
      action: 'auth.password_reset.completed',
      actorId: user.id,
      actorEmail: user.email,
      actorIp: meta.ip,
      metadata: { revokedSessions },
    });
  }

  private async checkResetRateLimit(email: string, ip: string | null | undefined): Promise<void> {
    // Deliberately NOT prefixed `pwreset:` — that prefix means "a stored
    // token" everywhere else (passwordResetRedisKey below), and a rate
    // counter is a different kind of thing with a different lifecycle.
    // Keeping them namespace-distinct means a `KEYS pwreset:*` scan (e.g.
    // for the count of outstanding tokens) never has to account for
    // counters mixed into the results.
    const emailKey = `pwreset_rl:email:${email.trim().toLowerCase()}`;
    const emailCount = await this.redis.client.incr(emailKey);
    if (emailCount === 1) await this.redis.client.expire(emailKey, RESET_REQUEST_WINDOW_SECONDS);

    let ipCount = 0;
    if (ip) {
      const ipKey = `pwreset_rl:ip:${ip}`;
      ipCount = await this.redis.client.incr(ipKey);
      if (ipCount === 1) await this.redis.client.expire(ipKey, RESET_REQUEST_WINDOW_SECONDS);
    }

    if (emailCount > RESET_REQUEST_LIMIT_PER_EMAIL || ipCount > RESET_REQUEST_LIMIT_PER_IP) {
      throw new HttpException('Muitas solicitações em pouco tempo — aguarde antes de tentar novamente.', HttpStatus.TOO_MANY_REQUESTS);
    }
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

function passwordResetRedisKey(token: string): string {
  // Store by hash, not the raw token — same rule bootstrapRedisKey
  // (node-bootstrap.service.ts) already follows: a credential value
  // never sits in cleartext at rest, even in Redis, even short-lived.
  return `pwreset:${createHash('sha256').update(token).digest('hex')}`;
}
