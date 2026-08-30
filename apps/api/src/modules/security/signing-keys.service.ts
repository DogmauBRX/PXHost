import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { CapabilityTokenService, signingKeyAad } from '../../core/capability-token/capability-token.service';
import { generateSeedPubKeypair } from '../../core/capability-token/ed25519';

export interface PublicSigningKey {
  kid: string;
  publicKey: string;
  state: string;
}

/**
 * Admin-facing half of capability-token signing key rotation
 * (architecture doc 3.4/roadmap M13). The full design describes
 * time-scheduled promotion (a "next" key published 24h ahead, promoted
 * automatically, the old one retired 24h after that) — this
 * implementation does the SAME state machine (current -> retiring ->
 * retired) but promotion is a single admin-triggered action rather than
 * a timer: rotate() both generates AND promotes a new key in one call.
 * This is the deliberate scope cut for this milestone; the schema
 * (createdAt/promotedAt/retiredAt all tracked separately) is exactly
 * what a future scheduled-promotion job would need, so upgrading later
 * is additive, not a redesign.
 *
 * Every agent verifies against the JWKS (JwksController), not a single
 * pinned key — a rotation is only "zero-downtime" because the OLD key
 * stays in the JWKS (state=retiring) after a new one starts signing, so
 * a console token minted seconds before rotation still verifies right
 * up to its own expiry. retire() (called explicitly, or by a future
 * scheduled job) is the point a key actually stops being served.
 */
@Injectable()
export class SigningKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly capabilityToken: CapabilityTokenService,
  ) {}

  async rotate(actorId: string): Promise<{ kid: string }> {
    const { seedPub, publicKeyRaw } = generateSeedPubKeypair();
    const kid = 'k-' + Date.now().toString(36);

    await this.prisma.$transaction(async (tx) => {
      await tx.signingKey.updateMany({ where: { state: 'current' }, data: { state: 'retiring' } });
      await tx.signingKey.create({
        data: {
          kid,
          publicKey: publicKeyRaw.toString('base64'),
          privateKeyEnc: Buffer.from(this.crypto.encrypt(seedPub.toString('base64'), signingKeyAad(kid)), 'utf8'),
          state: 'current',
          promotedAt: new Date(),
        },
      });
    });

    // Every NEW mint() call must use the new key immediately — no
    // restart, no window where this call returns but the service is
    // still signing with the just-retired key.
    await this.capabilityToken.reloadCurrentKey();

    await this.audit.record({ action: 'admin.signing_key.rotated', actorId, targetType: 'signing_key', targetId: kid });
    return { kid };
  }

  /** Fully removes a retiring key from the JWKS — any token still signed with it stops verifying. Call once you're sure nothing minted under it is still outstanding (its longest possible TTL has passed). */
  async retire(kid: string, actorId: string): Promise<void> {
    await this.prisma.signingKey.update({
      where: { kid },
      data: { state: 'retired', retiredAt: new Date(), privateKeyEnc: null },
    });
    await this.audit.record({ action: 'admin.signing_key.retired', actorId, targetType: 'signing_key', targetId: kid });
  }

  /** Every non-retired key's PUBLIC half — what JwksController serves and what SigningKeysController's admin listing shows. */
  async listPublic(): Promise<PublicSigningKey[]> {
    const rows = await this.prisma.signingKey.findMany({
      where: { state: { in: ['current', 'retiring'] } },
      orderBy: { createdAt: 'desc' },
      select: { kid: true, publicKey: true, state: true },
    });
    return rows;
  }
}
