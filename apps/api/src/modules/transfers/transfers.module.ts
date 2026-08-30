import { Module } from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { TransferQueueService } from './transfer-queue.service';
import { TransfersController } from './transfers.controller';
import { RemoteTransfersController } from './remote-transfers.controller';
import { NodesModule } from '../nodes/nodes.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [NodesModule, AuditModule],
  providers: [TransfersService, TransferQueueService],
  controllers: [TransfersController, RemoteTransfersController],
  exports: [TransfersService],
})
export class TransfersModule {}
