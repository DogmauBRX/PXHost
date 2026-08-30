import { Module } from '@nestjs/common';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingController } from './billing.controller';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [ServersModule],
  providers: [BillingWebhookService],
  controllers: [BillingController],
})
export class BillingModule {}
