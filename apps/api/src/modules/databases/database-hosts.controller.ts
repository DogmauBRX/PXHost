import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { DatabaseHostsService } from './database-hosts.service';
import { CreateDatabaseHostDto, UpdateDatabaseHostDto } from './dto/database-host.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

@Controller('api/admin/database-hosts')
@UseGuards(AdminGuard)
export class DatabaseHostsController {
  constructor(private readonly hosts: DatabaseHostsService) {}

  @Get()
  list() {
    return this.hosts.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.hosts.get(id);
  }

  @Post()
  create(@Body() dto: CreateDatabaseHostDto) {
    return this.hosts.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDatabaseHostDto) {
    return this.hosts.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.hosts.remove(id);
  }
}
