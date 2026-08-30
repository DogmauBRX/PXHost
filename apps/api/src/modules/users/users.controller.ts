import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { ListUsersDto } from './dto/list-users.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

@Controller('api/admin/users')
@UseGuards(AdminGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }
}
