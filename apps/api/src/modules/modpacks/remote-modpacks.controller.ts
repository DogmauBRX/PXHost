import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedNode, NodeAuthGuard } from '../nodes/guards/node-auth.guard';
import { ModpackProgressDto, ResolveCurseForgeFilesDto } from './dto/install-modpack.dto';
import { ModpacksService } from './modpacks.service';

@Controller('api/remote/servers/:serverId/modpacks')
@Public()
@UseGuards(NodeAuthGuard)
export class RemoteModpacksController {
  constructor(private readonly modpacks: ModpacksService) {}

  @Post('progress')
  async progress(@Param('serverId') serverId: string, @Body() dto: ModpackProgressDto, @Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    await this.modpacks.reportProgress(node.id, serverId, dto);
    return { ok: true };
  }

  @Post('curseforge/resolve')
  resolveCurseForgeFiles(@Param('serverId') serverId: string, @Body() dto: ResolveCurseForgeFilesDto, @Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    return this.modpacks.resolveCurseForgeFiles(node.id, serverId, dto);
  }
}
