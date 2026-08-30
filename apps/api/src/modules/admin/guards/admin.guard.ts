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
 * Fine-grained admin permission strings (admin.nodes.*, admin.plans.*,
 * ...) are a later milestone; for M4 this is deliberately coarse —
 * `root_admin` / `admin` / `support` all pass, `user` never does — matching
 * how little admin surface exists so far (nodes, locations, templates).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user?.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
