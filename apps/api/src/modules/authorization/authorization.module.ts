import { Module } from '@nestjs/common';
import { ServerAccessService } from './server-access.service';
import { PermissionCatalogService } from './permission-catalog.service';

@Module({
  providers: [ServerAccessService, PermissionCatalogService],
  exports: [ServerAccessService, PermissionCatalogService],
})
export class AuthorizationModule {}
