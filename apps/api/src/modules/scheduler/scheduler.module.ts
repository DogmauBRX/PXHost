import { Module } from '@nestjs/common';
import { CapacityModule } from '../capacity/capacity.module';
import { NodeSchedulerService } from './node-scheduler.service';

@Module({
  imports: [CapacityModule],
  providers: [NodeSchedulerService],
  exports: [NodeSchedulerService],
})
export class SchedulerModule {}
