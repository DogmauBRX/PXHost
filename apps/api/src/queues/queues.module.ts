import { Module } from '@nestjs/common';
import { ScheduleTickProcessor } from './schedule-tick.processor';
import { ScheduleDispatchProcessor } from './schedule-dispatch.processor';
import { PartitionMaintenanceProcessor } from './partition-maintenance.processor';
import { ServerTransferProcessor } from './server-transfer.processor';
import { OrderProvisioningProcessor } from './order-provisioning.processor';
import { WebhookProcessingProcessor } from './webhook-processing.processor';
import { BillingCycleProcessor } from './billing-cycle.processor';
import { BillingReconciliationProcessor } from './billing-reconciliation.processor';
import { SchedulesModule } from '../modules/schedules/schedules.module';
import { PartitionsModule } from '../modules/partitions/partitions.module';
import { TransfersModule } from '../modules/transfers/transfers.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { AuditModule } from '../modules/audit/audit.module';
import { ServersModule } from '../modules/servers/servers.module';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';

// Only ever imported by WorkerModule (src/worker.ts's root) — the HTTP
// API process (src/main.ts's AppModule) never imports this, so it never
// starts CONSUMING schedule-tick/schedule-dispatch/partition-maintenance/
// server-transfer/order-provisioning/webhook-processing/billing-cycle/
// billing-reconciliation jobs itself (architecture doc 3.7:
// "Workers run as a separate process ... from the API so a slow backup
// job never touches request latency") — the API process still IMPORTS
// TransfersModule/PaymentsModule on its own (see app.module.ts) to
// PRODUCE jobs and serve the admin/remote/webhook HTTP routes; only the
// Worker construct here.
@Module({
  imports: [SchedulesModule, PartitionsModule, TransfersModule, PaymentsModule, AuditModule, ServersModule, SubscriptionsModule],
  providers: [
    ScheduleTickProcessor,
    ScheduleDispatchProcessor,
    PartitionMaintenanceProcessor,
    ServerTransferProcessor,
    OrderProvisioningProcessor,
    WebhookProcessingProcessor,
    BillingCycleProcessor,
    BillingReconciliationProcessor,
  ],
})
export class QueuesModule {}
