import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { TestimonialsService } from './testimonials.service';

/** Landing-page depoimentos — admin-approved AND admin-featured only; see TestimonialsService.listPublicFeatured. */
@Controller('api/public/testimonials')
@Public()
export class PublicTestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}

  @Get()
  list() {
    return this.testimonials.listPublicFeatured();
  }
}
