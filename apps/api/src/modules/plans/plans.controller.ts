import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { PlansService } from './plans.service';
import { CreatePlanDto, SetPlanNodesDto, UpdatePlanDto } from './dto/plan.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/plans')
@UseGuards(AdminGuard, AdminPermissionGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequireAdminPermission('plans.view')
  list() {
    return this.plans.list();
  }

  @Get(':id')
  @RequireAdminPermission('plans.view')
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @Post()
  @RequireAdminPermission('plans.manage')
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @RequireAdminPermission('plans.manage')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  @Delete(':id')
  @RequireAdminPermission('plans.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.plans.remove(id);
  }

  /** Read-only report: which servers this plan's CURRENT values would change, and how — architecture doc 2.1/9's "dry run." */
  @Get(':id/drift')
  @RequireAdminPermission('plans.view')
  drift(@Param('id') id: string) {
    return this.plans.drift(id);
  }

  /** The actual "apply to N servers" job — updates each drifted server's DB snapshot and best-effort pushes resource changes live to its agent. */
  @Post(':id/apply')
  @RequireAdminPermission('plans.manage')
  apply(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.applyToServers(id, user.id);
  }

  /** Which nodes this plan may be scheduled onto (capacity plan Fase 4/5) — empty means every node. */
  @Get(':id/nodes')
  @RequireAdminPermission('plans.view')
  listNodes(@Param('id') id: string) {
    return this.plans.listAllowedNodes(id);
  }

  /** Replaces the full eligible-node set for this plan — see `PlansService.setAllowedNodes`'s doc comment. */
  @Put(':id/nodes')
  @RequireAdminPermission('plans.manage')
  setNodes(@Param('id') id: string, @Body() dto: SetPlanNodesDto, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.setAllowedNodes(id, dto.nodes, user.id);
  }
}
