import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/plans')
@UseGuards(AdminGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @Post()
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.plans.remove(id);
  }

  /** Read-only report: which servers this plan's CURRENT values would change, and how — architecture doc 2.1/9's "dry run." */
  @Get(':id/drift')
  drift(@Param('id') id: string) {
    return this.plans.drift(id);
  }

  /** The actual "apply to N servers" job — updates each drifted server's DB snapshot and best-effort pushes resource changes live to its agent. */
  @Post(':id/apply')
  apply(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.applyToServers(id, user.id);
  }
}
