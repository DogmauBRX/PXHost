import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // Liveness: no dependency checks. Must stay 200 even if Postgres/Redis
  // are down, or an orchestrator would kill a perfectly healthy process
  // during a database blip (architecture doc 3.6 §7 observability table).
  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  // Readiness: checks each dependency independently and reports which one
  // is failing, rather than a single opaque boolean.
  @Public()
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply) {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const ok = db.ok && redis.ok;
    reply.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', dependencies: { database: db, redis } };
  }

  private async checkDb(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async checkRedis(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.redis.client.ping();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
