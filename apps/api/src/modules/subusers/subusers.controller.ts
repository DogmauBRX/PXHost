import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { SubusersService } from './subusers.service';
import { InviteSubuserDto, UpdateSubuserPermissionsDto } from './dto/subuser.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/subusers')
export class SubusersController {
  constructor(private readonly subusers: SubusersService) {}

  @Get()
  list(@Param('serverId') serverId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.subusers.list(user.id, serverId);
  }

  @Post()
  invite(@Param('serverId') serverId: string, @Body() dto: InviteSubuserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.subusers.invite(user.id, serverId, dto);
  }

  @Patch(':subuserId')
  updatePermissions(@Param('serverId') serverId: string, @Param('subuserId') subuserId: string, @Body() dto: UpdateSubuserPermissionsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.subusers.updatePermissions(user.id, serverId, subuserId, dto);
  }

  @Delete(':subuserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('serverId') serverId: string, @Param('subuserId') subuserId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.subusers.remove(user.id, serverId, subuserId);
  }
}

@Controller('api/client/permission-catalog')
export class PermissionCatalogController {
  constructor(private readonly subusers: SubusersService) {}

  @Get()
  list() {
    return this.subusers.listPermissionCatalog();
  }
}
