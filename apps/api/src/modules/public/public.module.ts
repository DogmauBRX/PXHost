import { Module } from '@nestjs/common';
import { CapacityModule } from '../capacity/capacity.module';
import { SiteAnnouncementModule } from '../site-announcement/site-announcement.module';
import { PublicPlansService } from './public-plans.service';
import { PublicPlansController } from './public-plans.controller';
import { PublicStatusService } from './public-status.service';
import { PublicStatusController } from './public-status.controller';
import { PublicTemplatesService } from './public-templates.service';
import { PublicTemplatesController } from './public-templates.controller';

@Module({
  imports: [CapacityModule, SiteAnnouncementModule],
  providers: [PublicPlansService, PublicStatusService, PublicTemplatesService],
  controllers: [PublicPlansController, PublicStatusController, PublicTemplatesController],
  exports: [PublicPlansService, PublicStatusService, PublicTemplatesService],
})
export class PublicModule {}
