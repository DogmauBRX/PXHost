import './core/bigint-json.polyfill';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './core/config/env.schema';
import { CoreModule } from './core/core.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { HealthModule } from './modules/health/health.module';
import { LocationsModule } from './modules/locations/locations.module';
import { NodesModule } from './modules/nodes/nodes.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { PlansModule } from './modules/plans/plans.module';
import { ServersModule } from './modules/servers/servers.module';
import { FilesModule } from './modules/files/files.module';
import { BackupsModule } from './modules/backups/backups.module';
import { DatabasesModule } from './modules/databases/databases.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { ActivityModule } from './modules/activity/activity.module';
import { SubusersModule } from './modules/subusers/subusers.module';
import { PartitionsModule } from './modules/partitions/partitions.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { SecurityModule } from './modules/security/security.module';
import { BillingModule } from './modules/billing/billing.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    CoreModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    HealthModule,
    LocationsModule,
    NodesModule,
    TemplatesModule,
    PlansModule,
    ServersModule,
    FilesModule,
    BackupsModule,
    DatabasesModule,
    SchedulesModule,
    ActivityModule,
    SubusersModule,
    PartitionsModule,
    TransfersModule,
    SecurityModule,
    BillingModule,
    UsersModule,
  ],
  providers: [
    // JwtAuthGuard is global: every route requires authentication unless
    // explicitly marked @Public() (architecture doc default-deny posture).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
