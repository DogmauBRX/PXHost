import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { TransfersService } from './transfers.service';
import { Public } from '../auth/decorators/public.decorator';
import { NodeAuthGuard, AuthenticatedNode } from '../nodes/guards/node-auth.guard';

class TransferResultDto {
  @IsString()
  transferId!: string;

  @IsBoolean()
  successful!: boolean;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}

/** The TARGET agent's callback once its async import finishes — see agent/internal/panel/client.go's TransferResult doc comment. */
@Controller('api/remote/transfers')
@Public()
@UseGuards(NodeAuthGuard)
export class RemoteTransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post('result')
  async result(@Body() dto: TransferResultDto, @Req() req: FastifyRequest) {
    const node = (req as unknown as { node: AuthenticatedNode }).node;
    await this.transfers.handleResult(node.id, dto.transferId, dto.successful, dto.errorMessage);
    return { ok: true };
  }
}
