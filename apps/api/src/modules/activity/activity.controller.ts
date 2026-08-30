import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { ServerAccessService } from '../authorization/server-access.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly access: ServerAccessService,
  ) {}

  @Get()
  async list(@Param('serverId') serverId: string, @CurrentUser() user: AuthenticatedUser) {
    const { can } = await this.access.resolve(user.id, serverId);
    if (!can('activity.read')) throw new ForbiddenException('Missing permission: activity.read');
    return this.activity.list(user.id, serverId);
  }
}
