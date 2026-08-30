import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { NodeBootstrapService } from './node-bootstrap.service';
import { BootstrapRequestDto, HeartbeatDto } from './dto/node.dto';
import { Public } from '../auth/decorators/public.decorator';
import { NodeAuthGuard, AuthenticatedNode } from './guards/node-auth.guard';

/**
 * Everything under /api/remote/* is called ONLY by a Node Agent, never a
 * browser or a user (architecture doc 2.9). `bootstrap` is the one
 * exception authenticated by the bootstrap token in the body rather than
 * NodeAuthGuard — by definition, the agent has no node token yet at that
 * point. Every other route requires NodeAuthGuard explicitly (these
 * routes are also `@Public()` to exempt them from the global
 * JwtAuthGuard, which only understands user JWTs and would otherwise
 * 401 an agent's bearer token before NodeAuthGuard ever runs).
 */
@Controller('api/remote/nodes')
@Public()
export class RemoteNodesController {
  constructor(private readonly bootstrap: NodeBootstrapService) {}

  @Post('bootstrap')
  bootstrapNode(@Body() dto: BootstrapRequestDto) {
    return this.bootstrap.bootstrap(dto);
  }

  @Post('heartbeat')
  @UseGuards(NodeAuthGuard)
  heartbeat(@Req() req: FastifyRequest, @Body() dto: HeartbeatDto) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    return this.bootstrap.heartbeat(node.id, dto);
  }

  /** Agent-initiated self-rotation (architecture doc roadmap M13) — see NodeBootstrapService.rotateSelf's doc comment for why this is zero-downtime. */
  @Post('rotate-token')
  @UseGuards(NodeAuthGuard)
  rotateToken(@Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    return this.bootstrap.rotateSelf(node.id);
  }
}
