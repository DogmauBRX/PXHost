import { Module } from '@nestjs/common';
import { ServersService } from './servers.service';
import { ClientServersService } from './client-servers.service';
import { ServersController } from './servers.controller';
import { ClientServersController } from './client-servers.controller';
import { RemoteServersController } from './remote-servers.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DatabasesModule } from '../databases/databases.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  imports: [NodesModule, AuditModule, AuthorizationModule, DatabasesModule, ActivityModule],
  providers: [ServersService, ClientServersService],
  controllers: [ServersController, ClientServersController, RemoteServersController],
  exports: [ServersService, ClientServersService],
})
export class ServersModule {}
