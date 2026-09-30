import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { TestimonialsService } from './testimonials.service';
import { ModerateTestimonialDto } from './dto/testimonial.dto';

@Controller('api/admin/testimonials')
@UseGuards(AdminGuard)
export class AdminTestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}

  @Get()
  @RequireAdminPermission('testimonials.view')
  list(@Query('status') status?: 'pending' | 'approved' | 'rejected') {
    return this.testimonials.listForAdmin(status);
  }

  @Patch(':id')
  @RequireAdminPermission('testimonials.manage')
  moderate(@Param('id') id: string, @Body() dto: ModerateTestimonialDto, @CurrentUser() user: AuthenticatedUser) {
    return this.testimonials.moderate(id, dto, user.id);
  }
}
