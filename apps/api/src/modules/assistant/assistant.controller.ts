import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AssistantService } from './assistant.service';
import { AssistantChatDto } from './dto/assistant-chat.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/client/assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('chat')
  chat(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssistantChatDto) {
    return this.assistant.chat(user, dto.serverId, dto.message, dto.history ?? []);
  }

  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthenticatedUser, @Query('serverId') serverId: string) {
    return this.assistant.suggestions(user, serverId);
  }
}
