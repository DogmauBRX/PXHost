import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CapacityReportService } from './capacity-report.service';
import { SimulateCapacityDto } from './dto/simulate-capacity.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';

/**
 * Read-only reporting surface (capacity plan Fase 2). Deliberately no
 * `PATCH` here: every field an admin can change about a node's
 * commercial capacity (reserve, overallocate, maintenance, cpuTotal) is
 * already reachable through the existing `PATCH /api/admin/nodes/:id` —
 * duplicating that as `PATCH /api/admin/capacity/nodes/:id` would be
 * exactly the parallel-API the capacity plan was told not to create.
 * Every route is `capacity.view` — `simulate` doesn't persist or reserve
 * anything (see `nodeFitReasons`'s doc comment), so it's a query, not a
 * mutation, and there's no `capacity.manage` action for this controller
 * to gate (node capacity mutations live entirely under `nodes.manage`).
 */
@Controller('api/admin/capacity')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class CapacityController {
  constructor(private readonly report: CapacityReportService) {}

  @Get()
  @RequireAdminPermission('capacity.view')
  dashboard() {
    return this.report.dashboard();
  }

  @Get('nodes/:id')
  @RequireAdminPermission('capacity.view')
  nodeDetail(@Param('id') id: string) {
    return this.report.nodeDetail(id);
  }

  @Get('plans')
  @RequireAdminPermission('capacity.view')
  plans() {
    return this.report.planUsage();
  }

  @Post('simulate')
  @RequireAdminPermission('capacity.view')
  simulate(@Body() dto: SimulateCapacityDto) {
    return this.report.simulate(dto);
  }
}
