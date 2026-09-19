import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../../core/redis/redis.service';

@Injectable()
export class ModpackCacheService {
  constructor(private readonly redis: RedisService) {}

  async remember<T>(namespace: string, identity: unknown, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const key = `modpacks:${namespace}:${digest}`;
    const cached = await this.redis.client.get(key);
    if (cached !== null) return JSON.parse(cached) as T;

    const value = await load();
    await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return value;
  }

  /** Operational invalidation hook for provider metadata/catalog refreshes. */
  async invalidate(namespace: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [nextCursor, keys] = await this.redis.client.scan(cursor, 'MATCH', `modpacks:${namespace}:*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) removed += await this.redis.client.unlink(...keys);
    } while (cursor !== '0');
    return removed;
  }
}
