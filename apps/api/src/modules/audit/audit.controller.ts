import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditQueryService } from './audit-query.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

@Controller('api/admin/audit-logs')
@UseGuards(AdminGuard)
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  list(@Query() query: ListAuditLogsDto) {
    return this.audit.list(query);
  }
}
