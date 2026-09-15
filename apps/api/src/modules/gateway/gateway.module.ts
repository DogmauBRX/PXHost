import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { GatewayQueueService } from './gateway-queue.service';
import { GATEWAY_DRIVER } from './gateway-driver.interface';
import { HttpGatewayDriver } from './http-gateway.driver';
import { DNS_PROVIDER } from './dns/dns-provider.interface';
import { NoneDnsProvider } from './dns/none.dns-provider';
import { CloudflareDnsProvider } from './dns/cloudflare.dns-provider';
import { AuditModule } from '../audit/audit.module';

/**
 * Public-exposure plan. Same "one seam, one binding site" shape
 * `PaymentsModule` already establishes for `PAYMENT_PROVIDER`:
 * `GatewayService` and `GatewayReconcileProcessor` (in
 * `src/queues/gateway-reconcile.processor.ts`, wired into this module by
 * `QueuesModule`) depend on `GATEWAY_DRIVER`/`DNS_PROVIDER`, never on
 * `HttpGatewayDriver`/`CloudflareDnsProvider` directly.
 *
 * `DNS_PROVIDER` is the one binding chosen by env rather than fixed to a
 * single class — `PUBLIC_GATEWAY_DNS_PROVIDER` defaults to `NoneDnsProvider`
 * (no DNS write, ever) and only becomes `CloudflareDnsProvider` when an
 * admin explicitly opts in, per §16's "não altere DNS automaticamente em
 * produção sem deixar isso claramente configurável."
 */
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [GatewayController],
  providers: [
    GatewayService,
    GatewayQueueService,
    HttpGatewayDriver,
    NoneDnsProvider,
    CloudflareDnsProvider,
    { provide: GATEWAY_DRIVER, useClass: HttpGatewayDriver },
    {
      provide: DNS_PROVIDER,
      useFactory: (config: ConfigService, none: NoneDnsProvider, cloudflare: CloudflareDnsProvider) =>
        config.get<string>('PUBLIC_GATEWAY_DNS_PROVIDER') === 'cloudflare' ? cloudflare : none,
      inject: [ConfigService, NoneDnsProvider, CloudflareDnsProvider],
    },
  ],
  exports: [GatewayService],
})
export class GatewayModule {}
