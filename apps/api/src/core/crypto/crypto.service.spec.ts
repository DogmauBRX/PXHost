import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { CryptoService } from './crypto.service';

function makeCryptoService(overrides: Record<string, unknown> = {}): CryptoService {
  const config = new ConfigService({ APP_KEY: randomBytes(32).toString('base64'), ...overrides });
  const svc = new CryptoService(config);
  svc.onModuleInit();
  return svc;
}

describe('CryptoService', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const svc = makeCryptoService();
    const ciphertext = svc.encrypt('super secret value', 'node_tokens:token_hash:row-1');
    expect(svc.decrypt(ciphertext, 'node_tokens:token_hash:row-1')).toBe('super secret value');
  });

  it('produces a distinct ciphertext each time (random IV)', () => {
    const svc = makeCryptoService();
    const a = svc.encrypt('same plaintext', 'aad');
    const b = svc.encrypt('same plaintext', 'aad');
    expect(a).not.toBe(b);
  });

  it('rejects decryption with the wrong AAD — a ciphertext cannot be moved between rows', () => {
    const svc = makeCryptoService();
    const ciphertext = svc.encrypt('value', 'database_hosts:password_enc:host-1');
    expect(() => svc.decrypt(ciphertext, 'database_hosts:password_enc:host-2')).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag catches it)', () => {
    const svc = makeCryptoService();
    const stored = svc.encrypt('value', 'aad');
    const parts = stored.split('.');
    // flip a byte in the ciphertext segment
    const tampered = Buffer.from(parts[3], 'base64');
    tampered[0] ^= 0xff;
    parts[3] = tampered.toString('base64');
    expect(() => svc.decrypt(parts.join('.'), 'aad')).toThrow();
  });

  it('rejects a malformed envelope', () => {
    const svc = makeCryptoService();
    expect(() => svc.decrypt('not.enough.parts', 'aad')).toThrow();
  });

  it('supports decrypting with a previous key version after rotation', () => {
    const oldKey = randomBytes(32).toString('base64');
    const svc = makeCryptoService({ APP_KEY: oldKey, APP_KEY_VERSION: 1 });
    const ciphertext = svc.encrypt('rotate me', 'aad');
    expect(ciphertext.startsWith('v1.')).toBe(true);

    const newKey = randomBytes(32).toString('base64');
    const rotated = makeCryptoService({ APP_KEY: newKey, APP_KEY_VERSION: 2, APP_KEY_PREVIOUS: oldKey });

    // the OLD ciphertext (tagged v1) must still decrypt correctly...
    expect(rotated.decrypt(ciphertext, 'aad')).toBe('rotate me');
    // ...and new writes must be tagged with the NEW version, v2, so a
    // future rotation can tell them apart from anything written before
    // this one (this is exactly the distinction the fixed bug collapsed).
    const freshCiphertext = rotated.encrypt('new value', 'aad');
    expect(freshCiphertext.startsWith('v2.')).toBe(true);
    expect(rotated.decrypt(freshCiphertext, 'aad')).toBe('new value');
  });

  it('rejects APP_KEY_PREVIOUS without a bumped APP_KEY_VERSION', () => {
    const config = new ConfigService({
      APP_KEY: randomBytes(32).toString('base64'),
      APP_KEY_PREVIOUS: randomBytes(32).toString('base64'),
      APP_KEY_VERSION: 1,
    });
    const svc = new CryptoService(config);
    expect(() => svc.onModuleInit()).toThrow(/bump APP_KEY_VERSION/);
  });

  it('throws if APP_KEY is missing at init', () => {
    const config = new ConfigService({});
    const svc = new CryptoService(config);
    expect(() => svc.onModuleInit()).toThrow();
  });
});
