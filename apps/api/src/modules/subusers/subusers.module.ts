import { Module } from '@nestjs/common';
import { SubusersController, PermissionCatalogController } from './subusers.controller';
import { SubusersService } from './subusers.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuditModule } from '../audit/audit.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  imports: [AuthorizationModule, AuditModule, ActivityModule],
  controllers: [SubusersController, PermissionCatalogController],
  providers: [SubusersService],
})
export class SubusersModule {}
