import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { GatewayService } from './gateway.service';
import { CreateGatewayDto, UpdateGatewayDto } from './dto/gateway.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * Admin surface for public-exposure plan's `Gateway` rows. Deliberately
 * NOT where a route's day-to-day state lives — that's read off the
 * server itself (ServerView's `publicAddress`) — this is only for
 * standing up/reconfiguring the VPS gateway(s) themselves, same relative
 * scope `NodesController` has for physical nodes.
 */
@Controller('api/admin/gateways')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class GatewayController {
  constructor(private readonly gateways: GatewayService) {}

  @Get()
  @RequireAdminPermission('gateway.view')
  list() {
    return this.gateways.listGateways();
  }

  @Post()
  @RequireAdminPermission('gateway.manage')
  create(@Body() dto: CreateGatewayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gateways.createGateway(dto, user.id);
  }

  @Patch(':id')
  @RequireAdminPermission('gateway.manage')
  update(@Param('id') id: string, @Body() dto: UpdateGatewayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gateways.updateGateway(id, dto, user.id);
  }

  @Delete(':id')
  @RequireAdminPermission('gateway.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gateways.removeGateway(id, user.id);
  }

  /** Manual "reconcile now" — the same `reconcileOnce` the periodic worker calls, exposed for an admin to force it after fixing a `failed` route rather than waiting out the timer. */
  @Post('reconcile')
  @RequireAdminPermission('gateway.manage')
  async reconcile() {
    await this.gateways.reconcileOnce();
    return { reconciled: true };
  }
}
