import { Controller, Get } from '@nestjs/common';
import { PublicTemplatesService } from './public-templates.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * No auth, no cookie — same posture as `PublicPlansController`. Separate
 * from `TemplatesController` (`api/admin/eggs`, admin-only, returns raw
 * rows including `installScript`) rather than loosening that route's
 * guard — see `PublicTemplatesService`'s own doc comment for exactly
 * which fields this one is allowed to expose.
 */
@Controller('api/public/templates')
@Public()
export class PublicTemplatesController {
  constructor(private readonly templates: PublicTemplatesService) {}

  @Get()
  list() {
    return this.templates.list();
  }
}
