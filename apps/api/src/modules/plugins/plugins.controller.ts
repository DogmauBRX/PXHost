import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { PluginsService } from './plugins.service';
import type { ModpackSort } from '../modpacks/modpack-provider';

const SORTS = new Set<ModpackSort>(['relevance', 'popularity', 'downloads', 'updated']);

@Controller('api/client/servers/:serverId/plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}
  @Get('modrinth/search')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serverId') serverId: string,
    @Query('query') query = '',
    @Query('sort') requestedSort = 'downloads',
    @Query('offset') offset = '0',
  ) {
    const sort = SORTS.has(requestedSort as ModpackSort) ? requestedSort as ModpackSort : 'downloads';
    return this.plugins.search(user, serverId, query, sort, Math.max(0, Number(offset) || 0));
  }

  @Get('modrinth/:projectId')
  project(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('projectId') projectId: string) {
    return this.plugins.project(user, serverId, projectId);
  }

  @Get('modrinth/:projectId/versions')
  versions(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('projectId') projectId: string) {
    return this.plugins.versions(user, serverId, projectId);
  }

  @Post('modrinth/install')
  install(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serverId') serverId: string,
    @Body('projectId') projectId: string,
    @Body('versionId') versionId?: string,
  ) {
    return this.plugins.install(user, serverId, projectId, versionId);
  }

}
