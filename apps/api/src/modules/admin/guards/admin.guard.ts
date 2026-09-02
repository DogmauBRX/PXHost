import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/guards/jwt-auth.guard';

/**
 * Gates every `/api/admin/*` route. Runs AFTER JwtAuthGuard (global), so
 * `request.user` is already populated and verified — this guard only
 * checks the role bit JwtAuthGuard already resolved from the database
 * (architecture doc 3.3: admin actions go through a separate surface from
 * customer actions, and are audited separately — this is that surface's
 * front door).
 *
 * Deliberately coarse: `root_admin` / `admin` / `support` all pass,
 * `user` never does. Fine-grained gating for a SPECIFIC mutating action
 * (e.g. resetting a password, changing a role) is
 * `@RequireAdminPermission()` + `AdminPermissionGuard`
 * (admin-permissions.ts) layered on top of this one, not a replacement
 * for it — most read-only admin surface (nodes, locations, templates)
 * has no finer permission than "is staff at all," and this guard remains
 * that check.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user?.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    // Fails closed on an impersonated token (client account management
    // plan, Fase 6's seam) — see AdminPermissionGuard's identical check
    // for why this branch is dead code today and load-bearing later.
    if (user.impersonatorId) {
      throw new ForbiddenException('Impersonated sessions cannot access admin routes');
    }
    return true;
  }
}
