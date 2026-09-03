import { Module } from '@nestjs/common';
import { PublicPlansService } from './public-plans.service';
import { PublicPlansController } from './public-plans.controller';

@Module({
  providers: [PublicPlansService],
  controllers: [PublicPlansController],
  exports: [PublicPlansService],
})
export class PublicModule {}
