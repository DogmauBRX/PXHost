import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ClientServersService } from './client-servers.service';
import { ServerSetupService } from './server-setup.service';
import { PowerActionDto } from './dto/power.dto';
import { CompleteServerSetupDto } from './dto/server-setup.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';

/**
 * The logged-in customer's own view of their servers (architecture doc
 * 5.1's client area) — every method goes through ServerAccessService, so
 * "not yours" and "doesn't exist" are indistinguishable (404 either way)
 * for a non-admin caller. An admin caller (`user.isAdmin`, itself always
 * re-derived from the DB by JwtAuthGuard, never trusted from the request)
 * takes ServerAccessService.resolve's admin branch instead and reaches
 * ANY server — this is intentional: the admin per-server drill-down UI
 * (`/admin/servers/:id/*`) reuses these exact same routes rather than
 * duplicating console/file/backup logic behind a parallel admin surface.
 */
@Controller('api/client/servers')
export class ClientServersController {
  constructor(
    private readonly servers: ClientServersService,
    private readonly setup: ServerSetupService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.servers.list(user.id);
  }

  /** The setup screen's own data source — software catalog + current plan limits. See ServerSetupService.getSetupInfo's doc comment. */
  @Get(':id/setup')
  getSetup(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.setup.getSetupInfo(user, id);
  }

  /** First-time setup AND retry-after-failure both land here — see ServerSetupService.complete's doc comment for why the same call safely serves both. */
  @Post(':id/setup')
  completeSetup(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CompleteServerSetupDto) {
    return this.setup.complete(user, id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.servers.get(user, id);
  }

  /** Cheap, 10s-cached usage snapshot — powers the resource advisory without opening a WebSocket. See ClientServersService.stats's doc comment for the offline/suspended semantics. */
  @Get(':id/stats')
  stats(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.servers.stats(user, id);
  }

  /** On-demand real disk usage — a genuine filesystem walk, deliberately NOT part of the live stats stream. See ClientServersService.diskUsage's doc comment. */
  @Get(':id/disk-usage')
  diskUsage(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.servers.diskUsage(user, id);
  }

  @Post(':id/power')
  power(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: PowerActionDto) {
    return this.servers.power(user, id, dto.action);
  }

  @Post(':id/console-token')
  mintConsoleToken(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.servers.mintConsoleToken(user, id);
  }
}
