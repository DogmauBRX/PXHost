import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

const MEMO_TTL_MS = 60_000;

/**
 * The full list of permission keys, for services that need to compute
 * "which of ALL possible permissions does this caller actually have" —
 * e.g. surfacing `permissions: string[]` on a server's detail response so
 * the panel can hide actions a subuser doesn't have, rather than showing
 * a button that 403s.
 *
 * The catalog is DATA, not code (prisma/seed.ts's own comment: "adding a
 * key here is the only change needed to make a new permission exist; no
 * migration"), so this has to be a real read, not a hardcoded array — but
 * it changes at most at deploy time, so an in-process memo is ample and
 * avoids a DB round trip on every server-detail request.
 */
@Injectable()
export class PermissionCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private cached: { keys: string[]; at: number } | null = null;

  async keys(): Promise<string[]> {
    if (this.cached && Date.now() - this.cached.at < MEMO_TTL_MS) {
      return this.cached.keys;
    }
    const rows = await this.prisma.permissionCatalog.findMany({ select: { key: true } });
    const keys = rows.map((r) => r.key);
    this.cached = { keys, at: Date.now() };
    return keys;
  }
}
