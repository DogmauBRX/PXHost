import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { ListUsersDto } from './dto/list-users.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/users')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireAdminPermission('clients.view')
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }

  @Post()
  @RequireAdminPermission('clients.create')
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.create(dto, user);
  }

  @Patch(':id')
  @RequireAdminPermission('clients.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.update(id, dto, user);
  }

  @Post(':id/block')
  @RequireAdminPermission('clients.disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  block(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.setActive(id, false, user);
  }

  @Post(':id/unblock')
  @RequireAdminPermission('clients.disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  unblock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.setActive(id, true, user);
  }
}
