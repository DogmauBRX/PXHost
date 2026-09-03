import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { AccountService } from './account.service';
import { UpdateAccountDto, ChangePasswordDto } from './dto/account.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * Client account management, Fase 1 — the logged-in user's own profile.
 * No extra guard beyond the global JwtAuthGuard: every method reads the
 * target id ONLY from @CurrentUser(), never from the body or a route
 * param, so there is no id for a caller to substitute in the first place
 * (same posture as ClientServersController).
 */
@Controller('api/client/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.account.getProfile(user.id);
  }

  @Patch()
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateAccountDto) {
    return this.account.updateProfile(user.id, dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    await this.account.changePassword(user.id, dto);
    return { message: 'Senha alterada com sucesso.' };
  }
}
