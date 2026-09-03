import { Module } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { ClientPlansController } from './client-plans.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { CapacityModule } from '../capacity/capacity.module';
import { PublicModule } from '../public/public.module';

@Module({
  imports: [NodesModule, AuditModule, CapacityModule, PublicModule],
  providers: [PlansService],
  controllers: [PlansController, ClientPlansController],
  exports: [PlansService],
})
export class PlansModule {}
