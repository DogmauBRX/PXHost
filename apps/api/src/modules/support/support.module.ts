import { Module } from '@nestjs/common';
import { AdminSupportController } from './admin-support.controller';
import { ClientSupportController } from './client-support.controller';
import { SupportService } from './support.service';

@Module({
  controllers: [ClientSupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
