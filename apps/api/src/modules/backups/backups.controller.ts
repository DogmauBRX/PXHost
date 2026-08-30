import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { BackupsService } from './backups.service';
import { CreateBackupDto } from './dto/backup-ops.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/servers/:serverId/backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string) {
    return this.backups.list(user.id, serverId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: CreateBackupDto) {
    return this.backups.create(user.id, serverId, dto.ignorePatterns);
  }

  @Delete(':backupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('backupId') backupId: string) {
    return this.backups.delete(user.id, serverId, backupId);
  }

  @Post(':backupId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  restore(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('backupId') backupId: string) {
    return this.backups.restore(user.id, serverId, backupId);
  }

  @Post(':backupId/download-link')
  downloadLink(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Param('backupId') backupId: string) {
    return this.backups.mintDownloadLink(user.id, serverId, backupId);
  }
}
