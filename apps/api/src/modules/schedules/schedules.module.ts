import { Module } from '@nestjs/common';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { ScheduleRunnerService } from './schedule-runner.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuditModule } from '../audit/audit.module';
import { ServersModule } from '../servers/servers.module';
import { BackupsModule } from '../backups/backups.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  imports: [AuthorizationModule, AuditModule, ServersModule, BackupsModule, ActivityModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, ScheduleRunnerService],
  exports: [SchedulesService, ScheduleRunnerService],
})
export class SchedulesModule {}
