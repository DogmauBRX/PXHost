import { Module } from '@nestjs/common';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';
import { NodesModule } from '../nodes/nodes.module';

@Module({
  imports: [NodesModule],
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}
