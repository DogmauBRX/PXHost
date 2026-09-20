import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { ActivityModule } from '../activity/activity.module';
import { ModpackCacheService } from './modpack-cache.service';
import { ModpacksController } from './modpacks.controller';
import { ModpacksService } from './modpacks.service';
import { ModrinthProvider } from './modrinth.provider';
import { CurseForgeProvider } from './curseforge.provider';
import { RemoteModpacksController } from './remote-modpacks.controller';

@Module({
  imports: [AuthorizationModule, NodesModule, AuditModule, ActivityModule],
  controllers: [ModpacksController, RemoteModpacksController],
  providers: [ModpackCacheService, ModrinthProvider, CurseForgeProvider, ModpacksService],
  exports: [ModpacksService, ModrinthProvider, CurseForgeProvider],
})
export class ModpacksModule {}
