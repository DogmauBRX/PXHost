import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../../core/redis/redis.service';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { TokenService } from '../token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  jti: string;
  isAdmin: boolean;
  /** Raw `users.global_role` — `isAdmin` stays as the coarse boolean ~40 call sites already depend on; this is what rank/permission checks (client account management plan, admin/admin-permissions.ts) read instead of re-querying. */
  globalRole: string;
  /** Raw `users.admin_permissions` column — additive over the role's own defaults, never subtractive. Resolve with `resolveAdminPermissions()`, never read directly for an authorization decision. */
  adminPermissions: string[];
  /**
   * Reserved for impersonation (client account management plan, Fase 6),
   * never populated today — nothing in this codebase mints a token that
   * sets this. `AdminGuard`/`AdminPermissionGuard` refuse any token that
   * DOES carry it, so an impersonated session is structurally unable to
   * reach an admin route the day this seam is ever used, before the rest
   * of that feature (a two-token panel session model) exists at all.
   */
  impersonatorId?: string;
}

/**
 * Verifies the access token and checks it against both revocation
 * mechanisms described in architecture doc 3.3:
 *
 *  - the Redis denylist (jti and sid), populated on logout / reuse
 *    detection — checked as one pipelined round trip;
 *  - `users.tokens_valid_after`, a belt-and-suspenders check that still
 *    catches a denylisted-but-somehow-missed token even if Redis were
 *    ever flushed, since a token's `iat` can be compared without any
 *    external state.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request.headers['authorization']);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload;
    try {
      payload = this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const [jtiDenied, sidDenied] = await Promise.all([
      this.redis.isJtiDenylisted(payload.jti),
      this.redis.isSessionDenylisted(payload.sid),
    ]);
    if (jtiDenied || sidDenied) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, isActive: true, deletedAt: true, tokensValidAfter: true, globalRole: true, adminPermissions: true },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }
    // JWT `iat` has whole-SECOND resolution by spec; tokensValidAfter is a
    // millisecond-precision timestamp. Comparing them directly is a real
    // bug: a token minted in the SAME wall-clock second as a
    // tokensValidAfter bump (e.g. immediately after a reuse-detection
    // event on a fresh login) can have iat*1000 < tokensValidAfter purely
    // from sub-second rounding, even though the token was genuinely
    // issued after the bump — incorrectly rejecting a brand-new, valid
    // token. Flooring tokensValidAfter to the second before comparing
    // matches iat's own granularity; this mechanism is documented as a
    // belt-and-suspenders check behind the (millisecond-irrelevant) Redis
    // denylist, so second-level coarseness here is an acceptable, correct
    // trade-off, not a security gap.
    const tokensValidAfterSec = Math.floor(user.tokensValidAfter.getTime() / 1000);
    if (payload.iat < tokensValidAfterSec) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const authedUser: AuthenticatedUser = {
      id: user.id,
      sessionId: payload.sid,
      jti: payload.jti,
      isAdmin: user.globalRole !== 'user',
      globalRole: user.globalRole,
      adminPermissions: user.adminPermissions,
      // impersonatorId intentionally omitted — nothing populates payload.act yet (Fase 6 seam).
    };
    request.user = authedUser;
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
