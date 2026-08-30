import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { CryptoService } from './crypto/crypto.service';
import { CapabilityTokenService } from './capability-token/capability-token.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, CryptoService, CapabilityTokenService],
  exports: [PrismaService, RedisService, CryptoService, CapabilityTokenService],
})
export class CoreModule {}
