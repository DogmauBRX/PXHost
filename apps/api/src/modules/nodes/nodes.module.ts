import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodeBootstrapService } from './node-bootstrap.service';
import { AllocationsService } from './allocations.service';
import { AgentClient } from './agent-client.service';
import { NodesController } from './nodes.controller';
import { RemoteNodesController } from './remote-nodes.controller';
import { NodeAuthGuard } from './guards/node-auth.guard';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [NodesService, NodeBootstrapService, AllocationsService, AgentClient, NodeAuthGuard],
  controllers: [NodesController, RemoteNodesController],
  exports: [NodesService, AllocationsService, AgentClient, NodeAuthGuard],
})
export class NodesModule {}
