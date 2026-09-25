import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { AddSupportMessageDto, ListAdminSupportTicketsDto, UpdateSupportTicketDto } from './dto/support.dto';
import { SupportService } from './support.service';

@Controller('api/admin/support/tickets')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @RequireAdminPermission('support.view')
  list(@Query() dto: ListAdminSupportTicketsDto) {
    return this.support.listForAdmin(dto);
  }

  @Get(':id')
  @RequireAdminPermission('support.view')
  get(@Param('id') id: string) {
    return this.support.getForAdmin(id);
  }

  @Post(':id/messages')
  @RequireAdminPermission('support.manage')
  reply(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AddSupportMessageDto) {
    return this.support.replyAsAdmin(user.id, id, dto);
  }

  @Patch(':id')
  @RequireAdminPermission('support.manage')
  update(@Param('id') id: string, @Body() dto: UpdateSupportTicketDto) {
    return this.support.updateAsAdmin(id, dto);
  }

  @Delete(':id')
  @RequireAdminPermission('support.manage')
  remove(@Param('id') id: string) {
    return this.support.removeAsAdmin(id);
  }
}
