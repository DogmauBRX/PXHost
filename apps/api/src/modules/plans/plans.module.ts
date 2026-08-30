import { Module } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [NodesModule, AuditModule],
  providers: [PlansService],
  controllers: [PlansController],
  exports: [PlansService],
})
export class PlansModule {}
