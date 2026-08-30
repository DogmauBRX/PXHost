import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { CapabilityTokenService } from './capability-token.service';
import { CryptoService } from '../crypto/crypto.service';

// Mirrors Go's ed25519.PrivateKey layout (32-byte seed || 32-byte pubkey),
// the exact format PANEL_ED25519_PRIVATE_KEY is documented to hold.
function makeGoFormatKeypair(): { privateB64: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seedBuf = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const pubBuf = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { privateB64: Buffer.concat([seedBuf, pubBuf]).toString('base64'), publicKey };
}

function makeCrypto(): CryptoService {
  // APP_KEY_VERSION passed explicitly as a NUMBER, matching
  // crypto.service.spec.ts's own convention — @nestjs/config's
  // ConfigService falls back to process.env for any key missing from
  // the object passed to its constructor, and this repo's real .env has
  // APP_KEY_VERSION=1 as a STRING; without this, CryptoService ends up
  // storing/looking up its key map under "1" (string) vs 1 (number) and
  // decrypt() fails outright. The real app never hits this: ConfigModule.
  // forRoot's Zod validation (z.coerce.number()) runs first there.
  const crypto = new CryptoService(new ConfigService({ APP_KEY: randomBytes(32).toString('base64'), APP_KEY_VERSION: 1 }));
  crypto.onModuleInit();
  return crypto;
}

/** In-memory stand-in for the one Prisma model this service touches — a real PrismaService needs a live Postgres connection, which this unit test deliberately avoids (the DB-backed path is covered live in the M13 verification run, see api/README.md). */
function makeFakePrisma() {
  const rows: { kid: string; publicKey: string; privateKeyEnc: Buffer | null; state: string; createdAt: Date }[] = [];
  return {
    signingKey: {
      findFirst: jest.fn(async ({ where }: { where: { state: string } }) => rows.find((r) => r.state === where.state) ?? null),
      create: jest.fn(async ({ data }: { data: { kid: string; publicKey: string; privateKeyEnc: Buffer; state: string } }) => {
        const row = { ...data, createdAt: new Date() };
        rows.push(row);
        return row;
      }),
    },
  };
}

async function makeService(): Promise<{ svc: CapabilityTokenService; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] }> {
  const { privateB64, publicKey } = makeGoFormatKeypair();
  const svc = new CapabilityTokenService(
    new ConfigService({ PANEL_ED25519_PRIVATE_KEY: privateB64 }),
    makeFakePrisma() as any,
    makeCrypto(),
  );
  await svc.onModuleInit();
  return { svc, publicKey };
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('CapabilityTokenService', () => {
  it('mints a token whose signature verifies against the corresponding public key', async () => {
    const { svc, publicKey } = await makeService();
    const token = svc.mint({ serverUuid: 's-1', nodeUuid: 'n-1', userId: 'u-1', cap: 'ws', permissions: ['websocket.connect'], ttlSeconds: 60 });

    const [h, p, s] = token.split('.');
    const ok = verify(null, Buffer.from(`${h}.${p}`, 'utf8'), publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('sets alg=EdDSA, a kid, and every claim the agent verifier requires', async () => {
    const { svc } = await makeService();
    const token = svc.mint({ serverUuid: 'server-abc', nodeUuid: 'node-xyz', userId: 'user-1', cap: 'ws', permissions: ['control.console'], ttlSeconds: 120 });
    const [h, p] = token.split('.');

    const header = decodePart(h) as Record<string, unknown>;
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('JWT');
    expect(typeof header.kid).toBe('string');
    expect((header.kid as string).length).toBeGreaterThan(0);

    const payload = decodePart(p) as Record<string, unknown>;
    expect(payload.sub).toBe('server-abc');
    expect(payload.aud).toBe('node:node-xyz');
    expect(payload.cap).toBe('ws');
    expect(payload.uid).toBe('user-1');
    expect(payload.permissions).toEqual(['control.console']);
    expect(typeof payload.jti).toBe('string');
    expect((payload.jti as string).length).toBeGreaterThan(0);
    expect(payload.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('mints a fresh jti every time — a token is never replayable as a stand-in for another mint', async () => {
    const { svc } = await makeService();
    const a = svc.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 30 });
    const b = svc.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 30 });
    expect((decodePart(a.split('.')[1]) as { jti: string }).jti).not.toBe((decodePart(b.split('.')[1]) as { jti: string }).jti);
  });

  it('includes ctx for a file token, and omits it entirely for a console token', async () => {
    const { svc } = await makeService();
    const fileToken = svc.mint({
      serverUuid: 's',
      nodeUuid: 'n',
      userId: 'u',
      cap: 'file.download',
      permissions: [],
      ttlSeconds: 60,
      ctx: { path: 'server.properties', maxBytes: 1024 },
    });
    const filePayload = decodePart(fileToken.split('.')[1]) as Record<string, unknown>;
    expect(filePayload.cap).toBe('file.download');
    expect(filePayload.ctx).toEqual({ path: 'server.properties', maxBytes: 1024 });

    const wsToken = svc.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 60 });
    const wsPayload = decodePart(wsToken.split('.')[1]) as Record<string, unknown>;
    expect(wsPayload.ctx).toBeUndefined();
  });

  it('rejects a malformed key that is not 64 bytes', async () => {
    const svc = new CapabilityTokenService(
      new ConfigService({ PANEL_ED25519_PRIVATE_KEY: Buffer.from('too short').toString('base64') }),
      makeFakePrisma() as any,
      makeCrypto(),
    );
    await expect(svc.onModuleInit()).rejects.toThrow(/64 bytes/);
  });

  it('a signature made with a DIFFERENT key does not verify against this one', async () => {
    const { svc } = await makeService();
    const { publicKey: otherPublicKey } = makeGoFormatKeypair();
    const token = svc.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 30 });
    const [h, p, s] = token.split('.');
    const ok = verify(null, Buffer.from(`${h}.${p}`, 'utf8'), otherPublicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(false);
  });

  it('reuses the SAME seeded key across two onModuleInit calls sharing a Prisma backend — a restart never silently mints with a different key', async () => {
    const fakePrisma = makeFakePrisma();
    const { privateB64 } = makeGoFormatKeypair();
    const cfg = new ConfigService({ PANEL_ED25519_PRIVATE_KEY: privateB64 });
    // Same APP_KEY for both "processes" — a real restart keeps the same
    // env-configured master key; two DIFFERENT keys would make svc2
    // unable to decrypt what svc1 wrote, which isn't the scenario this
    // test is about.
    const crypto = makeCrypto();

    const svc1 = new CapabilityTokenService(cfg, fakePrisma as any, crypto);
    await svc1.onModuleInit();
    const token1 = svc1.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 30 });
    const kid1 = (decodePart(token1.split('.')[0]) as { kid: string }).kid;

    // A second "boot" against the SAME (fake) database — must find the
    // already-seeded row instead of minting a second "current" key.
    expect(fakePrisma.signingKey.create).toHaveBeenCalledTimes(1);
    const svc2 = new CapabilityTokenService(cfg, fakePrisma as any, crypto);
    await svc2.onModuleInit();
    expect(fakePrisma.signingKey.create).toHaveBeenCalledTimes(1); // still 1 — svc2 found the existing row, didn't reseed

    const token2 = svc2.mint({ serverUuid: 's', nodeUuid: 'n', userId: 'u', cap: 'ws', permissions: [], ttlSeconds: 30 });
    const kid2 = (decodePart(token2.split('.')[0]) as { kid: string }).kid;
    expect(kid2).toBe(kid1);
  });
});
