import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { CryptoService } from './crypto/crypto.service';
import { CapabilityTokenService } from './capability-token/capability-token.service';
import { MailService } from './mail/mail.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, CryptoService, CapabilityTokenService, MailService],
  exports: [PrismaService, RedisService, CryptoService, CapabilityTokenService, MailService],
})
export class CoreModule {}
