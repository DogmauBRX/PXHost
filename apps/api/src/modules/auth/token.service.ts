import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash, randomUUID } from 'node:crypto';

export interface AccessTokenPayload {
  sub: string; // user uuid
  sid: string; // session id
  jti: string;
  scp: 'session';
  adm: boolean; // cheap admin hint only — real permissions are always re-checked against the DB
  /**
   * Reserved for impersonation (client account management plan, Fase 6),
   * modeled on RFC 8693's actor claim — never set today; `signAccessToken`
   * has no parameter that produces it. When that feature is eventually
   * built, the mandatory order is: (1) rework the panel to a two-token
   * session model (`useAuthStore` holding both the admin's own token and
   * an impersonation token, with `apiFetch`'s 401-refresh path refusing
   * to run while impersonating — today it silently re-mints the ADMIN's
   * own token via the always-sent refresh cookie and leaves the UI
   * showing the impersonated client, see auth.store.ts/client.ts), THEN
   * (2) an endpoint that populates this claim. An impersonated token must
   * never carry a `Session` row, never accept a refresh, and expire in
   * minutes — `AdminGuard`/`AdminPermissionGuard` already refuse any
   * token whose resolved `AuthenticatedUser.impersonatorId` is set, so
   * until this claim is actually minted, no token can ever reach an
   * admin route this way regardless of what else is built first.
   */
  act?: { sub: string; jti: string };
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

const ISS = 'panel';
const AUD = 'panel-api';

/**
 * Mints and verifies access tokens (JWT, HS512) and opaque refresh tokens
 * (architecture doc 3.2). Refresh tokens are never JWTs — they are random
 * bytes whose SHA-256 is what gets stored, so a leaked database dump alone
 * can never be used to forge a session.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  signAccessToken(params: { userId: string; sessionId: string; isAdmin: boolean }): {
    token: string;
    jti: string;
    expiresIn: number;
  } {
    const expiresIn = this.config.get<number>('JWT_ACCESS_TTL_SECONDS')!;
    const jti = randomUUID();
    const token = this.jwt.sign(
      {
        sub: params.userId,
        sid: params.sessionId,
        jti,
        scp: 'session',
        adm: params.isAdmin,
      },
      { expiresIn, issuer: ISS, audience: AUD },
    );
    return { token, jti, expiresIn };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    // algorithms is pinned by JwtModule's global config (HS512 only); no
    // per-call override here, so there is no code path that could ever
    // accept a token signed with a different algorithm.
    return this.jwt.verify<AccessTokenPayload>(token, { issuer: ISS, audience: AUD });
  }

  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshTtlSeconds(): number {
    return this.config.get<number>('JWT_REFRESH_TTL_SECONDS')!;
  }
}
