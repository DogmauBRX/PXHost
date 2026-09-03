import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * The customer-facing half of the commercial site's subscriptions
 * surface — subscribe to a plan, see your own subscriptions, cancel one.
 * No AdminGuard: every authenticated user (customer or admin browsing
 * as themselves) may reach these routes, same posture as
 * ClientServersController. Ownership itself is enforced two ways at
 * once, matching every other client-facing controller in this codebase:
 * RLS on the subscriptions table (the real backstop) AND an explicit
 * `where userId` in SubscriptionsService (defense in depth, and what
 * keeps the 404-not-403 behavior legible without reading the SQL).
 */
@Controller('api/client/subscriptions')
export class ClientSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post()
  create(@Body() dto: CreateSubscriptionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.createForUser(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.listForUser(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.getForUser(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelSubscriptionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.cancelForUser(user.id, id, dto);
  }
}
