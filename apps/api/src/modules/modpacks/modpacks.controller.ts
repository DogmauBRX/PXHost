import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { ListModpackVersionsDto, SearchModpacksDto } from './dto/modpack-query.dto';
import type { ModpackSource } from './modpack-provider';
import { ModpacksService } from './modpacks.service';

@Controller('api/client/servers/:serverId/modpacks')
export class ModpacksController {
  constructor(private readonly modpacks: ModpacksService) {}

  @Get('search')
  search(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query() query: SearchModpacksDto) {
    return this.modpacks.search(user, serverId, query);
  }

  @Get(':source/metadata')
  metadata(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('source') source: ModpackSource) {
    return this.modpacks.metadata(user, serverId, source);
  }

  @Get(':source/:projectId')
  project(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serverId') serverId: string,
    @Param('source') source: ModpackSource,
    @Param('projectId') projectId: string,
  ) {
    return this.modpacks.project(user, serverId, source, projectId);
  }

  @Get(':source/:projectId/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serverId') serverId: string,
    @Param('source') source: ModpackSource,
    @Param('projectId') projectId: string,
    @Query() query: ListModpackVersionsDto,
  ) {
    return this.modpacks.versions(user, serverId, source, projectId, query);
  }
}
