import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/database.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/databases')
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  list(@Param('serverId') serverId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.databases.list(user, serverId);
  }

  @Post()
  create(@Param('serverId') serverId: string, @Body() dto: CreateDatabaseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.databases.create(user, serverId, dto);
  }

  @Delete(':databaseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('serverId') serverId: string, @Param('databaseId') databaseId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.databases.delete(user, serverId, databaseId);
  }
}
