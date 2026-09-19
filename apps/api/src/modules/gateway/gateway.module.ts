import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { GatewayQueueService } from './gateway-queue.service';
import { GATEWAY_DRIVER } from './gateway-driver.interface';
import { HttpGatewayDriver } from './http-gateway.driver';
import { DNS_PROVIDER } from './dns/dns-provider.interface';
import { NoneDnsProvider } from './dns/none.dns-provider';
import { PowerDnsProvider } from './dns/powerdns.dns-provider';
import { AuditModule } from '../audit/audit.module';

/**
 * Public-exposure plan. Same "one seam, one binding site" shape
 * `PaymentsModule` already establishes for `PAYMENT_PROVIDER`:
 * `GatewayService` and `GatewayReconcileProcessor` (in
 * `src/queues/gateway-reconcile.processor.ts`, wired into this module by
 * `QueuesModule`) depend on `GATEWAY_DRIVER`/`DNS_PROVIDER`, never on
 * `HttpGatewayDriver`/`PowerDnsProvider` directly.
 *
 * `DNS_PROVIDER` is the one binding chosen by env rather than fixed to a
 * single class — `PUBLIC_GATEWAY_DNS_PROVIDER` defaults to `NoneDnsProvider`
 * (no DNS write, ever) and only becomes `PowerDnsProvider` when an admin
 * explicitly opts in, per §16's "não altere DNS automaticamente em
 * produção sem deixar isso claramente configurável." Previously had a
 * `CloudflareDnsProvider` option here (removed) — game-server DNS is now
 * meant to run on GXhost's own authoritative nameservers (see
 * docs/DNS-POWERDNS.md), never a third-party provider's record quota;
 * `gxhost.com.br` itself (site/painel/API) is untouched by this and can
 * stay on whatever DNS host it already uses.
 */
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [GatewayController],
  providers: [
    GatewayService,
    GatewayQueueService,
    HttpGatewayDriver,
    NoneDnsProvider,
    PowerDnsProvider,
    { provide: GATEWAY_DRIVER, useClass: HttpGatewayDriver },
    {
      provide: DNS_PROVIDER,
      useFactory: (config: ConfigService, none: NoneDnsProvider, powerdns: PowerDnsProvider) =>
        config.get<string>('PUBLIC_GATEWAY_DNS_PROVIDER') === 'powerdns' ? powerdns : none,
      inject: [ConfigService, NoneDnsProvider, PowerDnsProvider],
    },
  ],
  exports: [GatewayService],
})
export class GatewayModule {}
