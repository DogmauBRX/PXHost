import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { PartitionsService } from './partitions.service';
import { AdminGuard } from '../admin/guards/admin.guard';

/** Manual trigger + inventory for the same maintenance the worker's daily repeatable job runs on its own — see PartitionMaintenanceProcessor. */
@Controller('api/admin/partitions')
@UseGuards(AdminGuard)
export class PartitionsController {
  constructor(private readonly partitions: PartitionsService) {}

  @Get()
  list() {
    return this.partitions.list();
  }

  @Post('maintain')
  @HttpCode(HttpStatus.NO_CONTENT)
  async maintain() {
    await this.partitions.ensureFuturePartitions();
    await this.partitions.archiveOldMetricPartitions();
  }
}
