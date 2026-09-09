import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { SiteAnnouncementService } from './site-announcement.service';
import { UpdateSiteAnnouncementDto } from './dto/update-site-announcement.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/site-announcement')
@UseGuards(AdminGuard)
export class SiteAnnouncementController {
  constructor(private readonly announcement: SiteAnnouncementService) {}

  @Get()
  get() {
    return this.announcement.getForAdmin();
  }

  @Patch()
  update(@Body() dto: UpdateSiteAnnouncementDto, @CurrentUser() user: AuthenticatedUser) {
    return this.announcement.update(dto, user.id);
  }
}
