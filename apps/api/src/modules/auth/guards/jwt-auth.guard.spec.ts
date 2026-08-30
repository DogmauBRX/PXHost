import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  const request: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const baseUser = { id: 'user-1', isActive: true, deletedAt: null, globalRole: 'user' };

  function makeGuard(opts: {
    tokensValidAfter: Date;
    iat: number;
    userOverrides?: Partial<typeof baseUser>;
    jtiDenied?: boolean;
    sidDenied?: boolean;
  }) {
    const tokens = {
      verifyAccessToken: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'sess-1', jti: 'jti-1', iat: opts.iat }),
    };
    const redis = {
      isJtiDenylisted: jest.fn().mockResolvedValue(Boolean(opts.jtiDenied)),
      isSessionDenylisted: jest.fn().mockResolvedValue(Boolean(opts.sidDenied)),
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...baseUser,
          ...opts.userOverrides,
          tokensValidAfter: opts.tokensValidAfter,
        }),
      },
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    return new JwtAuthGuard(tokens as any, redis as any, prisma as any, reflector as any);
  }

  it('allows a token whose iat is well after tokensValidAfter', async () => {
    const guard = makeGuard({ tokensValidAfter: new Date('2026-01-01T00:00:00.000Z'), iat: Math.floor(Date.parse('2026-01-01T00:01:00.000Z') / 1000) });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  // The regression this test locks in: iat has whole-SECOND resolution,
  // tokensValidAfter has millisecond resolution. A token minted in the
  // SAME second as the bump (even a few ms after it, chronologically
  // valid) must not be rejected just because iat*1000 rounds down below
  // tokensValidAfter's sub-second component.
  it('allows a token minted in the SAME second as tokensValidAfter (sub-second rounding must not reject it)', async () => {
    const bumpAt = new Date('2026-01-01T00:00:00.847Z'); // tokensValidAfter, sub-second precision
    const iatSameSecond = Math.floor(Date.parse('2026-01-01T00:00:00.900Z') / 1000); // truncates to :00.000
    const guard = makeGuard({ tokensValidAfter: bumpAt, iat: iatSameSecond });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a token whose iat is in an earlier second than tokensValidAfter', async () => {
    const guard = makeGuard({
      tokensValidAfter: new Date('2026-01-01T00:00:05.000Z'),
      iat: Math.floor(Date.parse('2026-01-01T00:00:03.000Z') / 1000),
    });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the jti is denylisted', async () => {
    const guard = makeGuard({ tokensValidAfter: new Date(0), iat: 9_999_999_999, jtiDenied: true });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the session id is denylisted', async () => {
    const guard = makeGuard({ tokensValidAfter: new Date(0), iat: 9_999_999_999, sidDenied: true });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the account is inactive', async () => {
    const guard = makeGuard({ tokensValidAfter: new Date(0), iat: 9_999_999_999, userOverrides: { isActive: false } });
    const ctx = makeContext({ authorization: 'Bearer token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing bearer token without calling verifyAccessToken', async () => {
    const guard = makeGuard({ tokensValidAfter: new Date(0), iat: 0 });
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
