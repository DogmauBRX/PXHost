import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let svc: PasswordService;

  beforeEach(() => {
    svc = new PasswordService();
  });

  it('hashes and verifies a correct password', async () => {
    const hash = await svc.hash('correct horse battery staple');
    await expect(svc.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await svc.hash('correct horse battery staple');
    await expect(svc.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('never throws on a malformed hash — verify() reports false', async () => {
    await expect(svc.verify('not-a-real-hash', 'anything')).resolves.toBe(false);
  });

  it('produces a hash with the current tuning parameters', async () => {
    const hash = await svc.hash('x');
    expect(hash).toMatch(/^\$argon2id\$v=\d+\$m=65536,t=3,p=2\$/);
  });

  it('needsRehash is false for a hash produced with current params', async () => {
    const hash = await svc.hash('x');
    expect(svc.needsRehash(hash)).toBe(false);
  });

  it('needsRehash is true for a hash with different params', () => {
    const oldHash = '$argon2id$v=19$m=4096,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVlaGVyZQ';
    expect(svc.needsRehash(oldHash)).toBe(true);
  });

  it('needsRehash is true for a non-argon2id string', () => {
    expect(svc.needsRehash('$2b$10$somebcrypthashvalue')).toBe(true);
  });

  it('dummyVerify resolves without throwing and takes real, non-trivial time', async () => {
    const start = Date.now();
    await expect(svc.dummyVerify()).resolves.toBeUndefined();
    // A real argon2id verify at these params takes tens of ms at minimum —
    // this is a coarse guard against dummyVerify() degenerating into a
    // no-op (e.g. a malformed hash rejected before the KDF ever runs),
    // which would silently reopen the account-enumeration timing gap this
    // method exists to close.
    expect(Date.now() - start).toBeGreaterThan(5);
  });

  it('dummyVerify is memoized: the hash is computed once, not per call', async () => {
    await svc.dummyVerify();
    const start = Date.now();
    await svc.dummyVerify();
    const second = Date.now() - start;
    // The second call skips the expensive `argon2.hash` (already cached)
    // and only pays for one `argon2.verify`, so it should be markedly
    // faster than hashing-then-verifying from scratch.
    expect(second).toBeLessThan(500);
  });
});
