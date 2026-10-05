import { Module } from '@nestjs/common';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { ModpacksModule } from '../modpacks/modpacks.module';
import { NodesModule } from '../nodes/nodes.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ServersModule } from '../servers/servers.module';
import { CanaryService } from './canary.service';

/** Worker side: the module that actually runs canaries (imported by QueuesModule only). */
@Module({
  imports: [ServersModule, PluginsModule, ModpacksModule, NodesModule, DiagnosticsModule],
  providers: [CanaryService],
  exports: [CanaryService],
})
export class CanaryModule {}
