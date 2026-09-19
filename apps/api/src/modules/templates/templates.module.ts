import { Module } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { SoftwareDiscoveryService } from './software-discovery.service';
import { TemplatesController } from './templates.controller';
import { PublicModule } from '../public/public.module';

@Module({
  imports: [PublicModule],
  providers: [TemplatesService, SoftwareDiscoveryService],
  controllers: [TemplatesController],
  // SoftwareDiscoveryService is also consumed by ServersModule's
  // ServerSetupService — the client-facing setup screen falls back to the
  // same live version discovery when a template isn't manually curated
  // yet (see that service's own doc comment).
  exports: [TemplatesService, SoftwareDiscoveryService],
})
export class TemplatesModule {}
