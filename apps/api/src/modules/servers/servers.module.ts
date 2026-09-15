import { Module } from '@nestjs/common';
import { ServersService } from './servers.service';
import { ClientServersService } from './client-servers.service';
import { ServerVariablesService } from './server-variables.service';
import { ServerHostnameService } from './server-hostname.service';
import { ServerSetupService } from './server-setup.service';
import { ServersController } from './servers.controller';
import { ClientServersController } from './client-servers.controller';
import { ServerVariablesController } from './server-variables.controller';
import { ServerHostnameController } from './server-hostname.controller';
import { RemoteServersController } from './remote-servers.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DatabasesModule } from '../databases/databases.module';
import { ActivityModule } from '../activity/activity.module';
import { CapacityModule } from '../capacity/capacity.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { PublicModule } from '../public/public.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [NodesModule, AuditModule, AuthorizationModule, DatabasesModule, ActivityModule, CapacityModule, SchedulerModule, PublicModule, GatewayModule],
  providers: [ServersService, ClientServersService, ServerVariablesService, ServerHostnameService, ServerSetupService],
  controllers: [ServersController, ClientServersController, ServerVariablesController, ServerHostnameController, RemoteServersController],
  exports: [ServersService, ClientServersService],
})
export class ServersModule {}
