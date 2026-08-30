import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { InitiateTransferDto } from './dto/transfer.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/** Admin-only: server transfer is a staff/ops action (architecture doc roadmap M13), never self-service. */
@Controller('api/admin/servers/:serverId/transfer')
@UseGuards(AdminGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  list(@Param('serverId') serverId: string) {
    return this.transfers.listForServer(serverId);
  }

  @Post()
  initiate(@Param('serverId') serverId: string, @Body() dto: InitiateTransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.initiate(serverId, dto.targetNodeId, dto.targetAllocationId, user.id);
  }
}
