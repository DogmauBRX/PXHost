import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';
import { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * Admin visibility and control over every customer's subscription
 * (commercial plan §18). Deliberately no PATCH/DELETE beyond the one
 * `status` transition endpoint — every other subscription field
 * (price/plan/period) is a snapshot taken at contract time and is never
 * edited in place, the same "snapshot, not reference" doctrine
 * `PlansService.update` already follows for servers.
 */
@Controller('api/admin/subscriptions')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class AdminSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @RequireAdminPermission('subscriptions.view')
  list(@Query() dto: ListSubscriptionsDto) {
    return this.subscriptions.listForAdmin(dto);
  }

  @Get(':id')
  @RequireAdminPermission('subscriptions.view')
  get(@Param('id') id: string) {
    return this.subscriptions.getForAdmin(id);
  }

  /** The ONLY path a subscription can ever reach `active` through — see SubscriptionsService.updateStatusAsAdmin's doc comment. */
  @Post(':id/status')
  @RequireAdminPermission('subscriptions.manage')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateSubscriptionStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.updateStatusAsAdmin(id, dto, user.id);
  }
}
