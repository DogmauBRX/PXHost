import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit, the recommended GCM nonce size

/**
 * Envelope-encrypts secrets at rest (node tokens, TOTP secrets, database
 * passwords) with AES-256-GCM, per architecture doc 3.6.
 *
 * Two things matter beyond "encrypt the bytes":
 *
 *  - The Additional Authenticated Data (AAD) is bound to the record's
 *    identity (`table:column:rowId`). This means a ciphertext copied from
 *    one row into another fails to decrypt — the encryption is bound to
 *    where it lives, not just what it is.
 *  - Stored format is `v<keyVersion>.<iv>.<tag>.<ciphertext>`, where
 *    `keyVersion` is `APP_KEY_VERSION` — an explicit, operator-incremented
 *    generation counter, NOT a hardcoded constant. This distinction is
 *    what makes rotation actually work: new writes must be tagged with a
 *    version number that is DIFFERENT from whatever old ciphertexts carry,
 *    so both can be looked up correctly at the same time. An earlier
 *    version of this service tagged every ciphertext with a fixed "v1"
 *    regardless of which real-world key generation was active — after a
 *    rotation, old "v1" ciphertexts (encrypted with the old key) and new
 *    "v1" ciphertexts (encrypted with the new key) became indistinguishable
 *    by tag, so decrypting an old record with the rotated-in service
 *    failed outright. Caught by CryptoService's own rotation test.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private keys = new Map<number, Buffer>();
  private currentVersion = 1;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const current = this.config.get<string>('APP_KEY');
    if (!current) {
      throw new Error('CryptoService: APP_KEY is not configured');
    }
    this.currentVersion = this.config.get<number>('APP_KEY_VERSION') ?? 1;
    this.keys.set(this.currentVersion, Buffer.from(current, 'base64'));

    const previous = this.config.get<string>('APP_KEY_PREVIOUS');
    if (previous) {
      if (this.currentVersion <= 1) {
        throw new Error(
          'CryptoService: APP_KEY_PREVIOUS is set but APP_KEY_VERSION is 1 — bump APP_KEY_VERSION when rotating',
        );
      }
      this.keys.set(this.currentVersion - 1, Buffer.from(previous, 'base64'));
    }
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error('CryptoService: no active key loaded');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      `v${this.currentVersion}`,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(stored: string, aad: string): string {
    const parts = stored.split('.');
    if (parts.length !== 4) {
      throw new Error('CryptoService: malformed ciphertext envelope');
    }
    const [versionTag, ivB64, tagB64, ctB64] = parts;
    const version = Number(versionTag.slice(1));
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`CryptoService: no key loaded for version ${version}`);
    }

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
