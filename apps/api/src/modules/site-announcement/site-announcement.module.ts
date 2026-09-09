import { Module } from '@nestjs/common';
import { SiteAnnouncementService } from './site-announcement.service';
import { SiteAnnouncementController } from './site-announcement.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [SiteAnnouncementService],
  controllers: [SiteAnnouncementController],
  exports: [SiteAnnouncementService],
})
export class SiteAnnouncementModule {}
