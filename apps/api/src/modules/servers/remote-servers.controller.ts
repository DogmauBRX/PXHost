import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { ServersService } from './servers.service';
import { Public } from '../auth/decorators/public.decorator';
import { NodeAuthGuard, AuthenticatedNode } from '../nodes/guards/node-auth.guard';

class InstallCompletedDto {
  @IsBoolean()
  successful!: boolean;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}

class ReportActivityDto {
  @IsString()
  userId!: string;

  @IsString()
  event!: string;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

/**
 * The agent's callback for install completion (architecture doc 4.2/7:
 * "the agent pulls/pushes state, the panel never blocks on a slow
 * install"). Guarded by NodeAuthGuard so only the node that actually owns
 * the server can report on it — reportInstallResult double-checks the
 * server row's nodeId against the calling node's id for exactly that
 * reason, not just the guard's bearer-token check.
 */
@Controller('api/remote/servers')
@Public()
@UseGuards(NodeAuthGuard)
export class RemoteServersController {
  constructor(private readonly servers: ServersService) {}

  @Post(':uuid/install-completed')
  async installCompleted(@Param('uuid') uuid: string, @Body() dto: InstallCompletedDto, @Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    await this.servers.reportInstallResult(node.id, uuid, dto.successful, dto.errorMessage);
    return { ok: true };
  }

  /** See agent/internal/panel/client.go's ReportActivity doc comment — the agent's only way to attribute a WS-driven power action to the panel's activity feed. */
  @Post(':uuid/activity')
  async reportActivity(@Param('uuid') uuid: string, @Body() dto: ReportActivityDto, @Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    await this.servers.reportRemoteActivity(node.id, uuid, dto.userId, dto.event, dto.properties);
    return { ok: true };
  }
}
