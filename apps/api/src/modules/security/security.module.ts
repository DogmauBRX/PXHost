import { Module } from '@nestjs/common';
import { SigningKeysService } from './signing-keys.service';
import { SigningKeysController } from './signing-keys.controller';
import { JwksController } from './jwks.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [SigningKeysService],
  controllers: [SigningKeysController, JwksController],
})
export class SecurityModule {}
