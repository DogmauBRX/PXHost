import { Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { AuthorizationModule } from '../authorization/authorization.module';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  imports: [AuthorizationModule, NodesModule, AuditModule, ActivityModule],
  providers: [FilesService],
  controllers: [FilesController],
})
export class FilesModule {}
