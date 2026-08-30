import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SigningKeysService } from './signing-keys.service';
import { AdminGuard } from '../admin/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

@Controller('api/admin/security/signing-keys')
@UseGuards(AdminGuard)
export class SigningKeysController {
  constructor(private readonly signingKeys: SigningKeysService) {}

  @Get()
  list() {
    return this.signingKeys.listPublic();
  }

  @Post('rotate')
  rotate(@CurrentUser() user: AuthenticatedUser) {
    return this.signingKeys.rotate(user.id);
  }

  @Post(':kid/retire')
  retire(@Param('kid') kid: string, @CurrentUser() user: AuthenticatedUser) {
    return this.signingKeys.retire(kid, user.id);
  }
}
