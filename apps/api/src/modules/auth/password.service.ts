import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

// Architecture doc 3.3: argon2id tuned to ~250ms on the target API host.
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 2,
  hashLength: 32,
};

const PARAMS_RE = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, HASH_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // A malformed/foreign hash format verifies as false, never throws
      // up to the caller — login failure must look identical regardless
      // of *why* verification failed.
      return false;
    }
  }

  /**
   * Runs a real argon2 verify against a constant, throwaway hash when the
   * account being logged into doesn't exist. Without this, an unknown
   * email returns "invalid credentials" near-instantly while a known
   * email with a wrong password takes ~250ms — a timing side-channel that
   * lets an attacker enumerate valid accounts (architecture doc 3.3).
   *
   * The dummy hash is computed for real (once, lazily, memoized) rather
   * than hand-typed, so it is a genuine argon2id PHC string of the right
   * salt/tag lengths — a fabricated string risks failing at the parsing
   * stage before argon2 ever runs the actual KDF, which would silently
   * defeat the whole point of this method.
   */
  async dummyVerify(): Promise<void> {
    const hash = await this.getDummyHash();
    await argon2.verify(hash, 'irrelevant-dummy-verify-password').catch(() => undefined);
  }

  private dummyHashPromise?: Promise<string>;
  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = argon2.hash('irrelevant-dummy-verify-password', HASH_OPTIONS);
    }
    return this.dummyHashPromise;
  }

  /**
   * True if the stored hash's parameters differ from the current
   * HASH_OPTIONS — the caller should rehash and persist on next
   * successful login (architecture doc 3.3: "rehash and update inside the
   * same transaction" when params drift, e.g. after a config change).
   */
  needsRehash(hash: string): boolean {
    const m = hash.match(PARAMS_RE);
    if (!m) return true; // not even argon2id-shaped -> force a rehash
    const [, memoryCost, timeCost, parallelism] = m.map(Number) as unknown as [never, number, number, number];
    return (
      memoryCost !== HASH_OPTIONS.memoryCost ||
      timeCost !== HASH_OPTIONS.timeCost ||
      parallelism !== HASH_OPTIONS.parallelism
    );
  }
}
