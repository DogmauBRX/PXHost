import { Module } from '@nestjs/common';
import { ScheduleTickProcessor } from './schedule-tick.processor';
import { ScheduleDispatchProcessor } from './schedule-dispatch.processor';
import { PartitionMaintenanceProcessor } from './partition-maintenance.processor';
import { ServerTransferProcessor } from './server-transfer.processor';
import { SchedulesModule } from '../modules/schedules/schedules.module';
import { PartitionsModule } from '../modules/partitions/partitions.module';
import { TransfersModule } from '../modules/transfers/transfers.module';

// Only ever imported by WorkerModule (src/worker.ts's root) — the HTTP
// API process (src/main.ts's AppModule) never imports this, so it never
// starts CONSUMING schedule-tick/schedule-dispatch/partition-maintenance/
// server-transfer jobs itself (architecture doc 3.7: "Workers run as a
// separate process ... from the API so a slow backup job never touches
// request latency") — the API process still IMPORTS TransfersModule on
// its own (see app.module.ts) to PRODUCE server-transfer jobs and serve
// the admin/remote HTTP routes; only the Worker construct here.
@Module({
  imports: [SchedulesModule, PartitionsModule, TransfersModule],
  providers: [ScheduleTickProcessor, ScheduleDispatchProcessor, PartitionMaintenanceProcessor, ServerTransferProcessor],
})
export class QueuesModule {}
