import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ServersService } from './servers.service';
import { CreateServerDto, SuspendServerDto } from './dto/server.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/servers')
@UseGuards(AdminGuard)
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  list(@Query('ownerId') ownerId?: string) {
    return this.servers.list(ownerId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.servers.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() dto: CreateServerDto) {
    return this.servers.create(dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.servers.remove(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  suspend(@Param('id') id: string, @Body() dto: SuspendServerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.servers.suspend(id, dto.reason, user.id);
  }

  @Post(':id/unsuspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  unsuspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.servers.unsuspend(id, user.id);
  }
}
