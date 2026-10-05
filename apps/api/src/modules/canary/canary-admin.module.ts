import { Module } from '@nestjs/common';
import { AdminCanaryController } from './admin-canary.controller';
import { CanaryQueueService } from './canary-queue.service';

/** API side: list runs and enqueue a manual run. */
@Module({
  providers: [CanaryQueueService],
  controllers: [AdminCanaryController],
})
export class CanaryAdminModule {}
