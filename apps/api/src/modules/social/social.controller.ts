import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { PublishServerDto, SearchUsersDto } from './dto/social.dto';
import { SocialService } from './social.service';

@Controller('api/client/community')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('users')
  searchUsers(@CurrentUser() user: AuthenticatedUser, @Query() query: SearchUsersDto) {
    return this.social.searchUsers(user.id, query.q);
  }

  @Get('friends')
  friends(@CurrentUser() user: AuthenticatedUser) {
    return this.social.friends(user.id);
  }

  @Post('friends/:userId')
  requestFriend(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.social.requestFriend(user.id, userId);
  }

  @Post('friends/:friendshipId/accept')
  acceptFriend(@CurrentUser() user: AuthenticatedUser, @Param('friendshipId') friendshipId: string) {
    return this.social.acceptFriend(user.id, friendshipId);
  }

  @Delete('friends/:friendshipId')
  removeFriend(@CurrentUser() user: AuthenticatedUser, @Param('friendshipId') friendshipId: string) {
    return this.social.removeFriend(user.id, friendshipId);
  }

  @Get('servers')
  directory(@CurrentUser() user: AuthenticatedUser) {
    return this.social.directory(user.id);
  }

  @Get('my-servers')
  myServers(@CurrentUser() user: AuthenticatedUser) {
    return this.social.myServers(user.id);
  }

  @Put('servers/:serverId')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: PublishServerDto) {
    return this.social.publish(user.id, serverId, dto.description ?? '');
  }

  @Delete('servers/:serverId')
  unpublish(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string) {
    return this.social.unpublish(user.id, serverId);
  }
}
