import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoProvider } from './mercadopago.provider';
import { PagBankClient } from './pagbank.client';
import { PagBankProvider } from './pagbank.provider';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningQueueService } from './provisioning-queue.service';
import { WebhookProcessingQueueService } from './webhook-processing-queue.service';
import { ClientOrdersController } from './client-orders.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { PagBankWebhookController } from './pagbank-webhook.controller';
import { PaymentProvidersController } from './payment-providers.controller';
import { AuditModule } from '../audit/audit.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CapacityModule } from '../capacity/capacity.module';
import { ServersModule } from '../servers/servers.module';

/**
 * `OrdersService`, the webhook, and the billing queues all inject
 * `PAYMENT_PROVIDER`, never `MercadoPagoProvider` directly — the binding
 * below is the ONLY place that names the concrete provider. There is
 * exactly one, deliberately: the seam exists to keep every HTTP detail
 * in one file and to let the e2e suite inject a fake, not to keep a
 * second provider alive.
 * `SubscriptionsModule` is imported for `SubscriptionsService.
 * lockAndValidatePlanForSubscription`/`createPendingSubscription`/
 * `applyTransition`/`applyRenewal`/`cancelForUser` — checkout and the
 * webhook both go through that ONE state machine, never a second one.
 * `CapacityModule` is imported for `CapacityService.lockPlan`, the
 * advisory lock the webhook reuses to serialize two notifications
 * racing on the same subscription. `ServersModule` is imported for
 * `ServersService.create`/`suspend`/`unsuspend` — provisioning and the
 * webhook's own recovery-reactivation path both need it.
 *
 * `ProvisioningService`/`ProvisioningQueueService`,
 * `PaymentsWebhookService`/`WebhookProcessingQueueService` (the actual
 * work) and their respective BullMQ consumers
 * (`OrderProvisioningProcessor`/`WebhookProcessingProcessor`,
 * `src/queues/`) all live behind this SAME module — `QueuesModule`
 * imports `PaymentsModule` (mirroring how it already imports
 * `TransfersModule` for `ServerTransferProcessor`) rather than
 * duplicating providers. The two queue *Service producers are exported
 * so the webhook/provisioning pipeline can enqueue jobs from within
 * this module, and so `QueuesModule`'s processors can be constructed
 * with everything they need.
 */
@Module({
  imports: [AuditModule, SubscriptionsModule, CapacityModule, ServersModule],
  providers: [
    MercadoPagoClient,
    { provide: PAYMENT_PROVIDER, useClass: MercadoPagoProvider },
    PagBankClient,
    PagBankProvider,
    PaymentProviderRegistry,
    OrdersService,
    PaymentsService,
    PaymentsWebhookService,
    ProvisioningService,
    ProvisioningQueueService,
    WebhookProcessingQueueService,
  ],
  controllers: [ClientOrdersController, AdminOrdersController, PaymentsWebhookController, PagBankWebhookController, PaymentProvidersController],
  exports: [PAYMENT_PROVIDER, PaymentProviderRegistry, OrdersService, PaymentsService, PaymentsWebhookService, ProvisioningService, ProvisioningQueueService, WebhookProcessingQueueService],
})
export class PaymentsModule {}
