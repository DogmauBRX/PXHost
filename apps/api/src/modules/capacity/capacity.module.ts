import { Module } from '@nestjs/common';
import { CapacityService } from './capacity.service';
import { CapacityReportService } from './capacity-report.service';
import { CapacityController } from './capacity.controller';

@Module({
  providers: [CapacityService, CapacityReportService],
  controllers: [CapacityController],
  exports: [CapacityService, CapacityReportService],
})
export class CapacityModule {}
