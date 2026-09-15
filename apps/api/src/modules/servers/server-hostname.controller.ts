import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ServerHostnameService } from './server-hostname.service';
import { UpdateServerHostnameDto } from './dto/server-hostname.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/hostname')
export class ServerHostnameController {
  constructor(private readonly hostname: ServerHostnameService) {}

  @Patch()
  update(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: UpdateServerHostnameDto) {
    return this.hostname.update(user, serverId, dto.hostname);
  }
}
