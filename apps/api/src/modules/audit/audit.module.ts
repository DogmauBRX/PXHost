import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';

@Module({
  providers: [AuditService, AuditQueryService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
