import { Module } from '@nestjs/common';
import { PartitionsService } from './partitions.service';
import { PartitionsController } from './partitions.controller';

@Module({
  providers: [PartitionsService],
  controllers: [PartitionsController],
  exports: [PartitionsService],
})
export class PartitionsModule {}
