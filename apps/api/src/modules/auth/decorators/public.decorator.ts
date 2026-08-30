import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as exempt from JwtAuthGuard (login, refresh, health checks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
