import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { ListUsersDto } from './dto/list-users.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/users')
@UseGuards(AdminGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.users.update(id, dto, user.id);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  block(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.setActive(id, false, user.id);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.NO_CONTENT)
  unblock(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.users.setActive(id, true, user.id);
  }
}
