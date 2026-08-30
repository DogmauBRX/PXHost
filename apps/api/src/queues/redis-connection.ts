import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * BullMQ's own connection, on a separate logical Redis DB from
 * RedisService's cache/denylist (architecture doc 3.7). `maxRetriesPerRequest:
 * null` is BullMQ's own documented requirement — it manages retries and
 * blocking commands itself; ioredis's default retry limit would make
 * BullMQ's blocking BRPOPLPUSH-style calls fail outright.
 */
export function createQueueRedisConnection(config: ConfigService): IORedis {
  const url = config.get<string>('QUEUE_REDIS_URL');
  if (!url) throw new Error('createQueueRedisConnection: QUEUE_REDIS_URL is not configured');
  return new IORedis(url, { maxRetriesPerRequest: null });
}
