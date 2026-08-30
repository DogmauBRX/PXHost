import { Module } from '@nestjs/common';
import { ServerAccessService } from './server-access.service';

@Module({
  providers: [ServerAccessService],
  exports: [ServerAccessService],
})
export class AuthorizationModule {}
