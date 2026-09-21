import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { RedisService } from '../../core/redis/redis.service';

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string | null;
}

interface GoogleOAuthState {
  verifier: string;
  nonce: string;
  redirectTo: string | undefined;
}

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_PROVIDER = 'google';

/**
 * Google OpenID Connect authorization-code flow with PKCE.
 *
 * The short-lived state (including the code verifier and nonce) stays only
 * in Redis. The browser receives an opaque state value, so neither an OAuth
 * code nor any credential ever passes through the panel bundle.
 */
@Injectable()
export class GoogleOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async begin(redirectTo?: string): Promise<string> {
    const settings = this.settings();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const key = this.stateKey(state);

    await this.redis.client.set(
      key,
      JSON.stringify({ verifier, nonce, redirectTo: safeRedirect(redirectTo) } satisfies GoogleOAuthState),
      'EX',
      STATE_TTL_SECONDS,
    );

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async complete(code: string | undefined, state: string | undefined): Promise<{ identity: GoogleIdentity; redirectTo?: string }> {
    const settings = this.settings();
    if (!code || !state) throw new BadRequestException('Resposta do Google incompleta. Tente entrar novamente.');

    const savedState = await this.consumeState(state);
    if (!savedState) throw new UnauthorizedException('Esta tentativa de login expirou. Tente novamente.');

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: settings.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: savedState.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { id_token?: unknown };
    if (!tokenResponse.ok || typeof tokenBody.id_token !== 'string') {
      throw new UnauthorizedException('Não foi possível validar o login com Google. Tente novamente.');
    }

    // Google's tokeninfo endpoint validates the signed ID token. We still
    // explicitly verify issuer, audience, verified email and nonce below;
    // these checks bind a valid Google token to this exact OAuth request.
    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenBody.id_token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const claims = (await verifyResponse.json().catch(() => ({}))) as Record<string, unknown>;
    const issuer = claims.iss;
    const emailVerified = claims.email_verified;
    if (
      !verifyResponse.ok ||
      claims.aud !== settings.clientId ||
      (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') ||
      claims.nonce !== savedState.nonce ||
      (emailVerified !== true && emailVerified !== 'true') ||
      typeof claims.sub !== 'string' ||
      typeof claims.email !== 'string'
    ) {
      throw new UnauthorizedException('Não foi possível validar o login com Google. Tente novamente.');
    }

    return {
      identity: {
        subject: claims.sub,
        email: claims.email.trim().toLowerCase(),
        name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : null,
      },
      redirectTo: savedState.redirectTo,
    };
  }

  failureRedirect(reason: 'cancelled' | 'unavailable' | 'failed'): string {
    const url = new URL('/login', this.config.getOrThrow<string>('PANEL_URL'));
    url.searchParams.set('oauthError', reason);
    return url.toString();
  }

  successRedirect(redirectTo?: string): string {
    const url = new URL('/login', this.config.getOrThrow<string>('PANEL_URL'));
    if (redirectTo) url.searchParams.set('redirect', redirectTo);
    url.searchParams.set('oauth', 'google');
    return url.toString();
  }

  private settings(): GoogleOAuthConfig {
    const clientId = this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException('O login com Google ainda não foi configurado.');
    }
    return { clientId, clientSecret, redirectUri };
  }

  private async consumeState(state: string): Promise<GoogleOAuthState | null> {
    // MULTI/EXEC makes GET + DEL one atomic Redis transaction, giving state
    // its single-use property even if a callback URL is replayed.
    const response = await this.redis.client.multi().get(this.stateKey(state)).del(this.stateKey(state)).exec();
    const raw = response?.[0]?.[1];
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as Partial<GoogleOAuthState>;
      if (typeof parsed.verifier !== 'string' || typeof parsed.nonce !== 'string') return null;
      return { verifier: parsed.verifier, nonce: parsed.nonce, redirectTo: safeRedirect(parsed.redirectTo) };
    } catch {
      return null;
    }
  }

  private stateKey(state: string): string {
    return `oauth:${GOOGLE_PROVIDER}:state:${createHash('sha256').update(state).digest('hex')}`;
  }
}

function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  return value.slice(0, 2_000);
}
