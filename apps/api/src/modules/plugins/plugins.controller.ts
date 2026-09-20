import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { PluginsService } from './plugins.service';

@Controller('api/client/servers/:serverId/plugins/modrinth')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}
  @Get('search') search(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query('query') query = '', @Query('offset') offset = '0') { return this.plugins.search(user, serverId, query, Math.max(0, Number(offset) || 0)); }
  @Post('install') install(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body('projectId') projectId: string) { return this.plugins.installLatest(user, serverId, projectId); }
}
