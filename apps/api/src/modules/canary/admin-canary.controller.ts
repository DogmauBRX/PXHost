import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CanaryQueueService } from './canary-queue.service';

@Controller('api/admin/canary')
@UseGuards(AdminGuard)
export class AdminCanaryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: CanaryQueueService,
  ) {}

  @Get('runs')
  @RequireAdminPermission('nodes.view')
  list() {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.canaryRun.findMany({ orderBy: { startedAt: 'desc' }, take: 15 }));
  }

  @Post('runs')
  @HttpCode(202)
  @RequireAdminPermission('nodes.manage')
  async trigger() {
    await this.queue.requestRun();
    return { queued: true };
  }
}
