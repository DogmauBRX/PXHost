import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { DiagnosticsService } from './diagnostics.service';

@Controller('api/admin/diagnostics')
@UseGuards(AdminGuard)
export class AdminDiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  @RequireAdminPermission('nodes.view')
  run() {
    return this.diagnostics.run();
  }
}
