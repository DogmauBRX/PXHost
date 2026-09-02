import { Controller, Get } from '@nestjs/common';
import { PlansService } from './plans.service';

/**
 * The customer-facing plan catalog — public plans only, customer-facing
 * columns only (`PlansService.listPublic`). No `AdminGuard`: any
 * authenticated user may see what plans exist, same posture as browsing a
 * pricing page. There is deliberately no `GET /:id` here — the whole
 * point of this endpoint is the catalog, for the upsell card to pick a
 * "next plan up" from; a single server's own plan already reaches the
 * client via `GET /api/client/servers/:id`.
 */
@Controller('api/client/plans')
export class ClientPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.listPublic();
  }
}
