import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { ActivityModule } from '../activity/activity.module';
import { ModpacksModule } from '../modpacks/modpacks.module';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
@Module({ imports: [AuthorizationModule, NodesModule, AuditModule, ActivityModule, ModpacksModule], controllers: [PluginsController], providers: [PluginsService] })
export class PluginsModule {}
