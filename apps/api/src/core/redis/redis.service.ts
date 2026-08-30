import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin Redis wrapper. Session revocation (architecture doc 3.3) lives here:
 * a denylist keyed `denylist:jti:<jti>` / `denylist:sid:<sid>`, TTL capped
 * at the access-token lifetime so the set never grows unbounded.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  public client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) throw new Error('RedisService: REDIS_URL is not configured');
    this.client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async denylistJti(jti: string, ttlSeconds: number): Promise<void> {
    await this.client.set(`denylist:jti:${jti}`, '1', 'EX', Math.max(1, ttlSeconds));
  }

  async isJtiDenylisted(jti: string): Promise<boolean> {
    return (await this.client.exists(`denylist:jti:${jti}`)) === 1;
  }

  async denylistSession(sid: string, ttlSeconds: number): Promise<void> {
    await this.client.set(`denylist:sid:${sid}`, '1', 'EX', Math.max(1, ttlSeconds));
  }

  async isSessionDenylisted(sid: string): Promise<boolean> {
    return (await this.client.exists(`denylist:sid:${sid}`)) === 1;
  }
}
