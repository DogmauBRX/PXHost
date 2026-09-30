import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { TestimonialsService } from './testimonials.service';
import { SubmitTestimonialDto } from './dto/testimonial.dto';

@Controller('api/client/testimonials')
export class ClientTestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.testimonials.mine(user);
  }

  @Get('eligibility')
  eligibility(@CurrentUser() user: AuthenticatedUser) {
    return this.testimonials.checkEligibility(user);
  }

  @Post()
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitTestimonialDto) {
    return this.testimonials.submit(user, dto);
  }
}
