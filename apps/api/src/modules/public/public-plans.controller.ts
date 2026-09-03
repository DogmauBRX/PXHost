import { Controller, Get, Param } from '@nestjs/common';
import { PublicPlansService } from './public-plans.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * The commercial catalog — no auth, no cookie, nothing customer-specific.
 * Separate from `ClientPlansController` (`GET /api/client/plans`, which
 * stays behind the JWT guard and keeps serving the "Meu Plano" upsell
 * card) rather than loosening that route's guard: an authenticated-only
 * route and a public one have different caching, different response
 * shapes (this one adds `availability`), and conflating them would mean
 * every future change to one risks silently changing the other.
 * `PlansService.listPublic` (`plans.service.ts`) is untouched — this
 * controller talks only to `PublicPlansService`, which wraps the same
 * kind of query with the commercial-site-specific `availability` field.
 */
@Controller('api/public/plans')
@Public()
export class PublicPlansController {
  constructor(private readonly plans: PublicPlansService) {}

  @Get()
  list() {
    return this.plans.list();
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.plans.getBySlug(slug);
  }
}
