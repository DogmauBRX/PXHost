import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ServersService } from './servers.service';
import { CreateServerDto, SuspendServerDto } from './dto/server.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/servers')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  @RequireAdminPermission('servers.view')
  list(@Query('ownerId') ownerId?: string) {
    return this.servers.list(ownerId);
  }

  @Get(':id')
  @RequireAdminPermission('servers.view')
  get(@Param('id') id: string) {
    return this.servers.get(id);
  }

  @Post()
  @RequireAdminPermission('servers.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() dto: CreateServerDto) {
    return this.servers.create(dto);
  }

  @Delete(':id')
  @RequireAdminPermission('servers.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.servers.remove(id);
  }

  @Post(':id/suspend')
  @RequireAdminPermission('servers.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  suspend(@Param('id') id: string, @Body() dto: SuspendServerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.servers.suspend(id, dto.reason, user.id);
  }

  @Post(':id/unsuspend')
  @RequireAdminPermission('servers.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  unsuspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.servers.unsuspend(id, user.id);
  }
}
