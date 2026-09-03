import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { ClientSubscriptionsController } from './client-subscriptions.controller';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { CapacityModule } from '../capacity/capacity.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [CapacityModule, AuditModule],
  providers: [SubscriptionsService],
  controllers: [ClientSubscriptionsController, AdminSubscriptionsController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
