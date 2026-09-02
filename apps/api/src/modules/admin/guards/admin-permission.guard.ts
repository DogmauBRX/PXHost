import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../../auth/guards/jwt-auth.guard';
import { ADMIN_PERMISSION_KEY } from '../decorators/require-admin-permission.decorator';
import { hasAdminPermission, type AdminPermission } from '../admin-permissions';

/**
 * Runs AFTER AdminGuard (which already refused non-admin roles), and is
 * a no-op on any handler that never calls `@RequireAdminPermission()` —
 * every existing admin controller is unaffected by this guard's
 * introduction. On a decorated handler, checks the resolved
 * role-default-plus-column permission set (admin-permissions.ts).
 *
 * Fails closed on an impersonated token (client account management plan,
 * Fase 6's seam): `impersonatorId` is never populated by anything today,
 * so this branch is dead code until that feature exists — but the day it
 * does, an impersonated session cannot reach a permission-gated admin
 * route no matter what permissions the impersonated actor's own token
 * would otherwise resolve to.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminPermission | undefined>(ADMIN_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user) throw new ForbiddenException('Admin access required');
    if (user.impersonatorId) throw new ForbiddenException('Impersonated sessions cannot access admin routes');

    if (!hasAdminPermission(user.globalRole, user.adminPermissions, required)) {
      throw new ForbiddenException(`Missing admin permission: ${required}`);
    }
    return true;
  }
}
