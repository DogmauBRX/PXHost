import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ServerVariablesService } from './server-variables.service';
import { UpdateServerVariablesDto } from './dto/server-variables.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/variables')
export class ServerVariablesController {
  constructor(private readonly variables: ServerVariablesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string) {
    return this.variables.list(user, serverId);
  }

  @Patch()
  update(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: UpdateServerVariablesDto) {
    return this.variables.update(user, serverId, dto.values);
  }
}
