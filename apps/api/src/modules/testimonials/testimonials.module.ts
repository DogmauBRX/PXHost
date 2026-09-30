import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TestimonialsService } from './testimonials.service';
import { ClientTestimonialsController } from './client-testimonials.controller';
import { AdminTestimonialsController } from './admin-testimonials.controller';
import { PublicTestimonialsController } from './public-testimonials.controller';

@Module({
  imports: [AuditModule],
  providers: [TestimonialsService],
  controllers: [ClientTestimonialsController, AdminTestimonialsController, PublicTestimonialsController],
})
export class TestimonialsModule {}
