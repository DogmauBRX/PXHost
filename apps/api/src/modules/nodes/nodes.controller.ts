import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodeBootstrapService } from './node-bootstrap.service';
import { AllocationsService } from './allocations.service';
import { CreateAllocationRangeDto, CreateNodeDto, UpdateNodeDto } from './dto/node.dto';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/nodes')
@UseGuards(AdminGuard)
export class NodesController {
  constructor(
    private readonly nodes: NodesService,
    private readonly bootstrap: NodeBootstrapService,
    private readonly allocations: AllocationsService,
  ) {}

  @Get()
  list() {
    return this.nodes.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.nodes.get(id);
  }

  @Post()
  create(@Body() dto: CreateNodeDto) {
    return this.nodes.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateNodeDto) {
    return this.nodes.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.nodes.remove(id);
  }

  // Single-use, 30-minute credential the operator pastes into
  // `pxagent bootstrap --token ...` on the physical/virtual node
  // (architecture doc 4.2/7). Never re-readable after this response.
  @Post(':id/bootstrap-token')
  issueBootstrapToken(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bootstrap.issueBootstrapToken(id, user.id);
  }

  // Compromise response: immediately kills the node's current token
  // (next heartbeat 401s) and returns a fresh single-use bootstrap
  // token for manual re-onboarding — see NodeBootstrapService.forceRotate's
  // doc comment for why this can't hand the new credential to the agent
  // directly the way rotateSelf (agent-initiated) does.
  @Post(':id/rotate-token')
  forceRotateToken(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bootstrap.forceRotate(id, user.id);
  }

  @Get(':id/allocations')
  listAllocations(@Param('id') id: string) {
    return this.allocations.listForNode(id);
  }

  @Post(':id/allocations')
  createAllocationRange(@Param('id') id: string, @Body() dto: CreateAllocationRangeDto) {
    return this.allocations.createRange(id, dto);
  }

  @Delete(':id/allocations/:allocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAllocation(@Param('id') id: string, @Param('allocationId') allocationId: string) {
    const parsed = parseBigIntParam(allocationId);
    return this.allocations.remove(id, parsed);
  }
}

function parseBigIntParam(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new NotFoundException('Allocation not found');
  }
}
