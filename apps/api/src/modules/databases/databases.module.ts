import { Module } from '@nestjs/common';
import { DatabaseHostsController } from './database-hosts.controller';
import { DatabaseHostsService } from './database-hosts.service';
import { DatabasesController } from './databases.controller';
import { DatabasesService } from './databases.service';
import { MysqlHostClient } from './mysql-host-client.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuditModule } from '../audit/audit.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  imports: [AuthorizationModule, AuditModule, ActivityModule],
  controllers: [DatabaseHostsController, DatabasesController],
  providers: [DatabaseHostsService, DatabasesService, MysqlHostClient],
  exports: [DatabaseHostsService, DatabasesService],
})
export class DatabasesModule {}
