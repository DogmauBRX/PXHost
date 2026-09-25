import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { AddSupportMessageDto, CreateSupportTicketDto } from './dto/support.dto';
import { SupportService } from './support.service';

@Controller('api/client/support/tickets')
export class ClientSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.support.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSupportTicketDto) {
    return this.support.createForUser(user.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.support.getForUser(user.id, id);
  }

  @Post(':id/messages')
  reply(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AddSupportMessageDto) {
    return this.support.replyAsUser(user.id, id, dto);
  }

}
