import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { DiagnosticsService } from './diagnostics.service';
import { AdminDiagnosticsController } from './admin-diagnostics.controller';

@Module({
  imports: [NodesModule, SchedulerModule],
  providers: [DiagnosticsService],
  controllers: [AdminDiagnosticsController],
})
export class DiagnosticsModule {}
