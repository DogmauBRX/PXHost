import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { SchedulesService } from './schedules.service';
import { CreateScheduleDto, CreateTaskDto, UpdateScheduleDto } from './dto/schedule.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@Param('serverId') serverId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.list(user, serverId);
  }

  @Post()
  create(@Param('serverId') serverId: string, @Body() dto: CreateScheduleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.create(user, serverId, dto);
  }

  @Patch(':scheduleId')
  update(@Param('serverId') serverId: string, @Param('scheduleId') scheduleId: string, @Body() dto: UpdateScheduleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.update(user, serverId, scheduleId, dto);
  }

  @Delete(':scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('serverId') serverId: string, @Param('scheduleId') scheduleId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.remove(user, serverId, scheduleId);
  }

  @Post(':scheduleId/tasks')
  addTask(@Param('serverId') serverId: string, @Param('scheduleId') scheduleId: string, @Body() dto: CreateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.addTask(user, serverId, scheduleId, dto);
  }

  @Delete(':scheduleId/tasks/:taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeTask(@Param('serverId') serverId: string, @Param('scheduleId') scheduleId: string, @Param('taskId') taskId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.removeTask(user, serverId, scheduleId, taskId);
  }
}
