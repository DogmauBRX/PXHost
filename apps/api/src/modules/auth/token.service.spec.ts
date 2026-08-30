import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

function makeTokenService(overrides: Record<string, unknown> = {}): TokenService {
  const config = new ConfigService({
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 1_209_600,
    ...overrides,
  });
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-characters-long', signOptions: { algorithm: 'HS512' } });
  return new TokenService(jwt, config);
}

describe('TokenService', () => {
  it('signs an access token that verifies back to the same claims', () => {
    const svc = makeTokenService();
    const { token, jti, expiresIn } = svc.signAccessToken({ userId: 'user-1', sessionId: 'session-1', isAdmin: false });

    expect(expiresIn).toBe(900);
    const payload = svc.verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.sid).toBe('session-1');
    expect(payload.jti).toBe(jti);
    expect(payload.adm).toBe(false);
    expect(payload.iss).toBe('panel');
    expect(payload.aud).toBe('panel-api');
  });

  it('every minted token gets a fresh, unique jti', () => {
    const svc = makeTokenService();
    const a = svc.signAccessToken({ userId: 'u', sessionId: 's', isAdmin: false });
    const b = svc.signAccessToken({ userId: 'u', sessionId: 's', isAdmin: false });
    expect(a.jti).not.toBe(b.jti);
  });

  it('rejects a token signed with a different secret', () => {
    const svc = makeTokenService();
    const other = makeTokenService();
    (other as any).jwt = new JwtService({ secret: 'a-completely-different-secret-value', signOptions: { algorithm: 'HS512' } });
    const forged = (other as any).jwt.sign({ sub: 'x', sid: 'y', jti: 'z', scp: 'session', adm: false }, { expiresIn: 900, issuer: 'panel', audience: 'panel-api' });

    expect(() => svc.verifyAccessToken(forged)).toThrow();
  });

  it('rejects an expired token', () => {
    const svc = makeTokenService({ JWT_ACCESS_TTL_SECONDS: -1 });
    const { token } = svc.signAccessToken({ userId: 'u', sessionId: 's', isAdmin: false });
    expect(() => svc.verifyAccessToken(token)).toThrow();
  });

  it('generateRefreshToken returns a token whose hash matches hashRefreshToken', () => {
    const svc = makeTokenService();
    const { token, hash } = svc.generateRefreshToken();
    expect(svc.hashRefreshToken(token)).toBe(hash);
  });

  it('refresh tokens are high-entropy and unique across calls', () => {
    const svc = makeTokenService();
    const a = svc.generateRefreshToken();
    const b = svc.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40); // 32 random bytes, base64url
  });

  it('refreshTtlSeconds reflects configuration', () => {
    const svc = makeTokenService({ JWT_REFRESH_TTL_SECONDS: 12345 });
    expect(svc.refreshTtlSeconds()).toBe(12345);
  });
});
