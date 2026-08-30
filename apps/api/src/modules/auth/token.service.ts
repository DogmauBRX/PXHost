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
