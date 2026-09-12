import { Module } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { SoftwareDiscoveryService } from './software-discovery.service';
import { TemplatesController } from './templates.controller';
import { PublicModule } from '../public/public.module';

@Module({
  imports: [PublicModule],
  providers: [TemplatesService, SoftwareDiscoveryService],
  controllers: [TemplatesController],
  exports: [TemplatesService],
})
export class TemplatesModule {}
