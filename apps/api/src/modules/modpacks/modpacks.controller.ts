import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { ListModpackVersionsDto, SearchModpacksDto } from './dto/modpack-query.dto';
import type { ModpackSource } from './modpack-provider';
import { ModpacksService } from './modpacks.service';
import { InstallModpackDto } from './dto/install-modpack.dto';

@Controller('api/client/servers/:serverId/modpacks')
export class ModpacksController {
  constructor(private readonly modpacks: ModpacksService) {}

  @Get('search')
  search(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query() query: SearchModpacksDto) {
    return this.modpacks.search(user, serverId, query);
  }

  @Post('installations')
  install(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: InstallModpackDto) {
    return this.modpacks.install(user, serverId, dto);
  }

  @Get('installations/latest')
  latestInstallation(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string) {
    return this.modpacks.latestInstallation(user, serverId);
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
