import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ListOrdersDto } from './dto/list-orders.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * Admin visibility and control over every customer's order/payment
 * (payments plan step 8) — the surface that didn't exist at all before
 * the Asaas migration (confirmed by audit: zero admin-facing orders
 * route anywhere in this codebase). Same shape
 * `AdminSubscriptionsController` already established: `AdminGuard` +
 * `AdminPermissionGuard`, one `RequireAdminPermission` per route.
 *
 * Deliberately NO "mark as paid" route — only a real payment
 * (`PaymentsWebhookService`, driven by Asaas's own webhook) ever moves
 * an order to `paid`. The two mutations here (`retry-provisioning`,
 * `refund`) both act on money/infrastructure that already exists,
 * never fabricate a payment.
 */
@Controller('api/admin/orders')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequireAdminPermission('payments.view')
  list(@Query() dto: ListOrdersDto) {
    return this.orders.listForAdmin(dto);
  }

  @Get(':id')
  @RequireAdminPermission('payments.view')
  get(@Param('id') id: string) {
    return this.orders.getForAdmin(id);
  }

  @Post(':id/retry-provisioning')
  @RequireAdminPermission('payments.manage')
  retryProvisioning(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.retryProvisioningAsAdmin(id, user.id);
  }

  @Post(':id/refund')
  @RequireAdminPermission('payments.manage')
  refund(@Param('id') id: string, @Body() dto: RefundOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.refundAsAdmin(id, dto.reason, user.id);
  }
}
