import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { BootstrapRequestDto, HeartbeatDto } from './dto/node.dto';
import { deriveHealthStatus } from './nodes.service';

const BOOTSTRAP_TTL_SECONDS = 30 * 60; // 30 min, single-use
const HEARTBEAT_INTERVAL_SECONDS = 15;

/**
 * The node provisioning handshake (architecture doc 4.2/7): an admin
 * mints a single-use bootstrap token; the agent presents it exactly once
 * to trade it for a long-lived node token. The bootstrap token itself
 * lives only in Redis (never the database) — it's a 30-minute-TTL,
 * burn-on-use credential, not a record anyone needs to audit or revoke
 * later, so it doesn't deserve a table.
 */
@Injectable()
export class NodeBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  static controlTokenAad(nodeId: string): string {
    return `nodes:control_token_enc:${nodeId}`;
  }

  async issueBootstrapToken(
    nodeId: string,
    actorId: string,
  ): Promise<{ token: string; expiresAt: Date; command: string }> {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node not found');

    const token = `bst_${randomBytes(24).toString('base64url')}`;
    const key = bootstrapRedisKey(token);
    await this.redis.client.set(key, nodeId, 'EX', BOOTSTRAP_TTL_SECONDS);

    const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_SECONDS * 1000);
    await this.audit.record({ action: 'admin.node.bootstrap_token_issued', actorId, targetType: 'node', targetId: nodeId });

    return {
      token,
      expiresAt,
      command: `pxagent bootstrap --panel <panel-url> --token ${token}`,
    };
  }

  async bootstrap(dto: BootstrapRequestDto): Promise<{ nodeUuid: string; nodeToken: string; heartbeatIntervalSeconds: number }> {
    const key = bootstrapRedisKey(dto.token);
    const nodeId = await this.redis.client.get(key);
    if (!nodeId) throw new UnauthorizedException('Invalid or expired bootstrap token');
    // Single-use: burn it immediately, before doing anything else, so a
    // retried/duplicated request can't mint two node tokens from one
    // bootstrap token racing the delete.
    await this.redis.client.del(key);

    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node no longer exists');

    // Revoke any existing active token for this node — a re-bootstrap
    // (e.g. after `pxagent bootstrap` is re-run) supersedes the old
    // credential rather than accumulating two "active" tokens, which the
    // `node_tokens_one_active` partial unique index would reject anyway.
    await this.prisma.nodeToken.updateMany({
      where: { nodeId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    // 12 raw bytes -> exactly 16 base64url characters (12*4/3, no padding),
    // matching the `token_id CHAR(16)` column precisely.
    const tokenId = randomBytes(12).toString('base64url');
    const secret = randomBytes(36).toString('base64url');
    const tokenHash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

    const fullToken = `${tokenId}.${secret}`;

    await this.prisma.nodeToken.create({
      data: { nodeId, tokenId, tokenHash, status: 'active' },
    });
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        dockerVersion: dto.dockerVersion,
        lastHeartbeatAt: new Date(),
        healthStatus: 'online',
        controlTokenEnc: Buffer.from(this.crypto.encrypt(fullToken, NodeBootstrapService.controlTokenAad(nodeId)), 'utf8'),
      },
    });

    await this.audit.record({
      action: 'node.bootstrap.completed',
      targetType: 'node',
      targetId: nodeId,
      metadata: { hostname: dto.hostname, os: dto.os, kernel: dto.kernel, dockerVersion: dto.dockerVersion, arch: dto.arch },
    });

    return { nodeUuid: nodeId, nodeToken: fullToken, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS };
  }

  /**
   * Agent-initiated self-rotation (architecture doc roadmap M13: "token
   * rotation"). Called with the node's CURRENT still-valid token
   * (NodeAuthGuard already proved possession by the time this runs) —
   * the response hands back a fresh one in the SAME round trip, so the
   * agent never has a moment without a working credential: it applies
   * the new token in memory and rewrites node.json before its NEXT
   * outbound call, and this method updates `controlTokenEnc` (what the
   * panel sends back to the agent) in the same breath, so both
   * directions agree on the new secret before either side's next call.
   * The old token is revoked in the SAME transaction that creates the
   * new one, matching `node_tokens_one_active`'s partial unique index —
   * Postgres would reject two simultaneously-active rows for one node
   * even if this tried to leave a real overlap window open.
   */
  async rotateSelf(nodeId: string): Promise<{ nodeToken: string }> {
    const tokenId = randomBytes(12).toString('base64url');
    const secret = randomBytes(36).toString('base64url');
    const tokenHash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const fullToken = `${tokenId}.${secret}`;

    await this.prisma.$transaction([
      this.prisma.nodeToken.updateMany({ where: { nodeId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } }),
      this.prisma.nodeToken.create({ data: { nodeId, tokenId, tokenHash, status: 'active' } }),
      this.prisma.node.update({
        where: { id: nodeId },
        data: { controlTokenEnc: Buffer.from(this.crypto.encrypt(fullToken, NodeBootstrapService.controlTokenAad(nodeId)), 'utf8') },
      }),
    ]);

    await this.audit.record({ action: 'node.token.self_rotated', targetType: 'node', targetId: nodeId });
    return { nodeToken: fullToken };
  }

  /**
   * Admin-forced revocation — the "credential compromised, kill it now"
   * path, distinct from rotateSelf above: there is no way to hand a
   * fresh token to an agent that might be unreachable or the very thing
   * being revoked FOR, so this deliberately does NOT try. It revokes the
   * active token immediately (the node's next heartbeat 401s) and issues
   * a fresh bootstrap token so an operator can manually re-bootstrap,
   * exactly like onboarding a brand new node.
   */
  async forceRotate(nodeId: string, actorId: string): Promise<{ token: string; expiresAt: Date; command: string }> {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null } });
    if (!node) throw new NotFoundException('Node not found');

    await this.prisma.nodeToken.updateMany({ where: { nodeId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
    await this.audit.record({ action: 'node.token.force_revoked', actorId, targetType: 'node', targetId: nodeId });

    return this.issueBootstrapToken(nodeId, actorId);
  }

  async heartbeat(nodeId: string, dto: HeartbeatDto): Promise<{ status: string }> {
    const node = await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        lastHeartbeatAt: new Date(),
        healthStatus: 'online',
        agentVersion: dto.agentVersion,
        dockerVersion: dto.dockerVersion,
      },
    });
    return { status: deriveHealthStatus(node.lastHeartbeatAt) };
  }
}

function bootstrapRedisKey(token: string): string {
  // Store by hash, not the raw token, matching the general rule that a
  // credential value never sits in cleartext at rest — even in Redis,
  // even for a 30-minute-lived one.
  return `bootstrap:${createHash('sha256').update(token).digest('hex')}`;
}
