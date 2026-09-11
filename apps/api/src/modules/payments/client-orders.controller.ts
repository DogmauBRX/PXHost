import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { OrdersService } from './orders.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { CancelSubscriptionDto } from '../subscriptions/dto/cancel-subscription.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * The customer-facing half of checkout — same posture as
 * `ClientSubscriptionsController`: no `AdminGuard`, every authenticated
 * user may reach these routes, ownership enforced by RLS plus an
 * explicit `where userId` in `OrdersService` (defense in depth).
 *
 * `subscriptions/:id/cancel` lives HERE, not on
 * `ClientSubscriptionsController`, specifically because cancelling
 * also has to cancel at the provider —
 * `OrdersService` is the only place already holding that dependency
 * (see this file's own routing, and `ClientSubscriptionsController`'s
 * own comment on why importing `PaymentsModule` there would be
 * circular).
 */
@Controller('api/client')
export class ClientOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('checkout')
  createCheckout(@Body() dto: CreateCheckoutDto, @CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    return this.orders.createCheckoutOrder(user.id, dto, this.requestMeta(req));
  }

  @Get('orders')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForUser(user.id);
  }

  @Get('orders/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.getForUser(user.id, id);
  }

  @Post('subscriptions/:id/cancel')
  cancelSubscription(@Param('id') id: string, @Body() dto: CancelSubscriptionDto = {}, @CurrentUser() user: AuthenticatedUser) {
    // A request with no body at all (no `reason`/`atPeriodEnd` — every
    // field on CancelSubscriptionDto is optional) comes through as
    // `dto === undefined`, not `{}`: Fastify's body parser never runs
    // when there's nothing to parse, so `@Body()` resolves to
    // `undefined` before the ValidationPipe ever gets a plain object to
    // instantiate. The default parameter above is what used to be
    // missing — without it this crashed with a 500 (`Cannot read
    // properties of undefined (reading 'reason')`) instead of reaching
    // OrdersService at all, on EVERY bodyless cancel request.
    return this.orders.cancelSubscriptionForUser(user.id, id, { reason: dto.reason, atPeriodEnd: dto.atPeriodEnd });
  }

  private requestMeta(req: FastifyRequest): { ip: string | null } {
    return { ip: req.ip ?? null };
  }
}
