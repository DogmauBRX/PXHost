import { createPrivateKey, generateKeyPairSync, KeyObject } from 'node:crypto';

// RFC 8410 §7: the PKCS8 DER encoding of a raw 32-byte Ed25519 private
// key is this fixed 16-byte prefix followed by the seed — there is no
// other variable content, so this constant is the entire "wrapping"
// needed to hand a raw seed to Node's crypto module. Shared between
// CapabilityTokenService (the env-configured seed key) and
// SigningKeysService (every key rotate() generates) so both produce
// KeyObjects the exact same way.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Reconstructs a signing KeyObject from Go's ed25519.PrivateKey layout: 32-byte seed followed by its 32-byte public key. */
export function privateKeyFromSeedPub(bytes: Buffer): KeyObject {
  if (bytes.length !== 64) {
    throw new Error(`privateKeyFromSeedPub: expected 64 bytes (seed+pub), got ${bytes.length}`);
  }
  const seed = bytes.subarray(0, 32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Generates a fresh Ed25519 keypair in the same seed+pub (64-byte) layout — used by SigningKeysService.rotate(). */
export function generateSeedPubKeypair(): { seedPub: Buffer; publicKeyRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const publicKeyRaw = Buffer.from(pubJwk.x, 'base64url');
  const seed = Buffer.from(privJwk.d, 'base64url');
  return { seedPub: Buffer.concat([seed, publicKeyRaw]), publicKeyRaw };
}
