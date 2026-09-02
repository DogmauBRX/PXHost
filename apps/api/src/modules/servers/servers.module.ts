import { Module } from '@nestjs/common';
import { ServersService } from './servers.service';
import { ClientServersService } from './client-servers.service';
import { ServerVariablesService } from './server-variables.service';
import { ServersController } from './servers.controller';
import { ClientServersController } from './client-servers.controller';
import { ServerVariablesController } from './server-variables.controller';
import { RemoteServersController } from './remote-servers.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DatabasesModule } from '../databases/databases.module';
import { ActivityModule } from '../activity/activity.module';
import { CapacityModule } from '../capacity/capacity.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [NodesModule, AuditModule, AuthorizationModule, DatabasesModule, ActivityModule, CapacityModule, SchedulerModule],
  providers: [ServersService, ClientServersService, ServerVariablesService],
  controllers: [ServersController, ClientServersController, ServerVariablesController, RemoteServersController],
  exports: [ServersService, ClientServersService],
})
export class ServersModule {}
