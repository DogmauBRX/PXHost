import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ModpackCacheService } from './modpack-cache.service';
import { ModpacksController } from './modpacks.controller';
import { ModpacksService } from './modpacks.service';
import { ModrinthProvider } from './modrinth.provider';

@Module({
  imports: [AuthorizationModule],
  controllers: [ModpacksController],
  providers: [ModpackCacheService, ModrinthProvider, ModpacksService],
  exports: [ModpacksService],
})
export class ModpacksModule {}
