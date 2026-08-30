import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../../core/prisma/prisma.service';

export interface AuthenticatedNode {
  id: string;
}

/**
 * Guards every `/api/remote/*` route — called ONLY by a Node Agent, never
 * by a browser or a user JWT (architecture doc 3.4 layer 2). A user's
 * access token is structurally rejected here: this guard only knows how
 * to verify `<tokenId>.<secret>` bearer tokens against the `node_tokens`
 * table, so a stolen user JWT presented here simply fails to parse as a
 * node token and is rejected — there is no code path that accepts both.
 *
 * Routes under `/api/remote/*` must also be `@Public()` (exempting them
 * from the global JwtAuthGuard, which only understands user JWTs) and
 * apply this guard explicitly instead.
 *
 * Full mTLS (architecture doc 3.4 layer 1) is deferred to a later
 * hardening milestone, per the architecture's own documented risk
 * acceptance for v1 ("Accept root-level agent for v1; document it. Post-
 * M13: mTLS between panel and agent.") — this bearer-token layer is v1's
 * actual boundary and is fully real, not a placeholder.
 */
@Injectable()
export class NodeAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const presented = extractBearerToken(request.headers['authorization']);
    if (!presented) throw new UnauthorizedException('Missing node token');

    const [tokenId, secret] = presented.split('.', 2);
    if (!tokenId || !secret) throw new UnauthorizedException('Malformed node token');

    const record = await this.prisma.nodeToken.findFirst({
      where: { tokenId, status: 'active' },
      select: { id: true, nodeId: true, tokenHash: true },
    });
    if (!record) throw new UnauthorizedException('Invalid node token');

    const valid = await argon2.verify(record.tokenHash, secret).catch(() => false);
    if (!valid) throw new UnauthorizedException('Invalid node token');

    // Best-effort, non-blocking: don't let a slow write stall the request.
    void this.prisma.nodeToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

    const node: AuthenticatedNode = { id: record.nodeId };
    request.node = node;
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
