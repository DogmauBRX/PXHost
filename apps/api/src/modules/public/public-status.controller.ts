import { Controller, Get } from '@nestjs/common';
import { PublicStatusService } from './public-status.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * No auth, no cookie — same posture as `PublicPlansController`. Two
 * routes rather than one combined payload on purpose: `AnnouncementBanner`
 * (rendered in both `PublicShell` and `AppShell`) only ever needs
 * `/announcement`, and fetching the node/location list on every
 * authenticated page load for a banner that ignores it would be waste.
 */
@Controller('api/public/status')
@Public()
export class PublicStatusController {
  constructor(private readonly status: PublicStatusService) {}

  @Get('announcement')
  announcement() {
    return this.status.getAnnouncement();
  }

  @Get('nodes')
  nodes() {
    return this.status.getNodeStatus();
  }
}
