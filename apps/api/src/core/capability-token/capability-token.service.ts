import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, sign, KeyObject } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { privateKeyFromSeedPub } from './ed25519';

export type Capability = 'ws' | 'file.download' | 'file.upload' | 'backup.download' | 'transfer.download';

export interface CapabilityContext {
  path?: string;
  maxBytes?: number;
}

export interface CapabilityMint {
  serverUuid: string;
  nodeUuid: string;
  userId: string;
  cap: Capability;
  permissions: string[];
  ttlSeconds: number;
  ctx?: CapabilityContext;
}

/** AAD binding for signing_keys.private_key_enc — see CryptoService's doc comment on why every encrypted column needs one. */
export function signingKeyAad(kid: string): string {
  return `signing_keys:private_key_enc:${kid}`;
}

/**
 * Mints the short-lived, Ed25519-signed "capability token" a browser uses
 * to connect directly to a node agent's console/stats WebSocket
 * (architecture doc 3.4/4.5) — verified entirely offline by the agent
 * against a JWKS it caches (architecture doc roadmap M13: "signing keys
 * carry next/current/retiring states"; agent/internal/panel's
 * FetchJWKS + agent/internal/auth's multi-key TokenVerifier are the
 * verifying side of this).
 *
 * The signing key itself now lives in `signing_keys` (DB), not solely
 * `PANEL_ED25519_PRIVATE_KEY` — that env var is only the SEED for the
 * very first key, read once on first boot if the table is still empty,
 * so an already-bootstrapped node's `panel_public_key_path` fallback
 * keeps verifying tokens with zero config changes. Every rotation after
 * that (SigningKeysService.rotate()) is DB-only; this service's
 * in-memory cache is refreshed by reloadCurrentKey(), called right after
 * a rotation commits, so the very next mint() already uses the new key —
 * no restart, no window where mint() and the JWKS disagree about which
 * key is current.
 */
@Injectable()
export class CapabilityTokenService implements OnModuleInit {
  private readonly logger = new Logger(CapabilityTokenService.name);
  private current!: { kid: string; privateKey: KeyObject };

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadCurrentKey();
  }

  /** Re-reads the current signing key from the DB — called on boot and again by SigningKeysService right after every rotation. */
  async reloadCurrentKey(): Promise<void> {
    const row = await this.prisma.signingKey.findFirst({ where: { state: 'current' }, orderBy: { createdAt: 'desc' } });
    if (row) {
      if (!row.privateKeyEnc) throw new Error(`CapabilityTokenService: current signing key ${row.kid} has no private key on file`);
      const seedPub = Buffer.from(this.crypto.decrypt(Buffer.from(row.privateKeyEnc).toString('utf8'), signingKeyAad(row.kid)), 'base64');
      this.current = { kid: row.kid, privateKey: privateKeyFromSeedPub(seedPub) };
      return;
    }

    // First boot, nothing in signing_keys yet: seed the table from the
    // env-configured key so an already-bootstrapped agent (whose
    // panel_public_key_path already has this exact public key on disk)
    // needs no changes. Every LATER rotation is DB-only.
    const raw = this.config.get<string>('PANEL_ED25519_PRIVATE_KEY');
    if (!raw) throw new Error('CapabilityTokenService: PANEL_ED25519_PRIVATE_KEY is not configured and no signing key exists in the database');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 64) {
      throw new Error(`CapabilityTokenService: PANEL_ED25519_PRIVATE_KEY must decode to 64 bytes (Go ed25519 seed+pub), got ${bytes.length}`);
    }
    const kid = 'seed-' + randomBytes(4).toString('hex');
    const publicKeyRaw = bytes.subarray(32);
    await this.prisma.signingKey.create({
      data: {
        kid,
        publicKey: publicKeyRaw.toString('base64'),
        privateKeyEnc: Buffer.from(this.crypto.encrypt(bytes.toString('base64'), signingKeyAad(kid)), 'utf8'),
        state: 'current',
        promotedAt: new Date(),
      },
    });
    this.current = { kid, privateKey: privateKeyFromSeedPub(bytes) };
    this.logger.log(`seeded signing key ${kid} from PANEL_ED25519_PRIVATE_KEY`);
  }

  /**
   * Builds and signs a compact JWS matching agent/internal/auth.Claims
   * field-for-field: `sub` is the server, `aud` is `"node:<nodeUuid>"`,
   * `jti` is required non-empty by the verifier. alg is EdDSA — the
   * agent rejects anything else outright, including "none". `kid`
   * identifies which key in the JWKS to verify against (roadmap M13).
   * `ctx` narrows a file.download/file.upload/backup.download/
   * transfer.download token to exactly one path — the agent's
   * VerifyFileToken rejects any presentation against a different path,
   * and burns the jti so the token can never be replayed.
   */
  mint({ serverUuid, nodeUuid, userId, cap, permissions, ttlSeconds, ctx }: CapabilityMint): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.current.kid };
    const payload = {
      sub: serverUuid,
      aud: `node:${nodeUuid}`,
      iat: now,
      nbf: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
      uid: userId,
      cap,
      permissions,
      ...(ctx ? { ctx } : {}),
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = sign(null, Buffer.from(signingInput, 'utf8'), this.current.privateKey);
    return `${signingInput}.${b64url(signature)}`;
  }
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}
