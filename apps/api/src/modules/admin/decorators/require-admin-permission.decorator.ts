import { SetMetadata } from '@nestjs/common';
import type { AdminPermission } from '../admin-permissions';

export const ADMIN_PERMISSION_KEY = 'adminPermission';

/** Marks a route as needing a specific admin permission on top of AdminGuard's coarse `isAdmin` check. Read by `AdminPermissionGuard`, which no-ops on any handler without this metadata — every admin controller that doesn't use it is completely unaffected. */
export const RequireAdminPermission = (permission: AdminPermission) => SetMetadata(ADMIN_PERMISSION_KEY, permission);
