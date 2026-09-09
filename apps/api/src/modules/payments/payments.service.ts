import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { GatewayPayment } from './payment-provider.interface';

/**
 * `payments` carries no RLS (0022_payments' own comment: written/read
 * exclusively by the webhook handler and admin routes, both already
 * admin-equivalent contexts — same posture `billing_events` already
 * established) — plain `this.prisma.payment.*` calls by default, no
 * `withRLS` wrapper, mirroring how `AuditService` talks to `audit_logs`
 * directly.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The ONLY place that writes a `Payment` row — upserted by the
   * PROVIDER's own payment id (the primary key), so recording the SAME
   * payment twice (two notifications about one payment: `PENDING` then
   * `RECEIVED`) updates the one row rather than creating a second.
   * Never decides anything about the ORDER — `PaymentsWebhookService`
   * is the one place that maps a payment's status onto what happens to
   * the order/subscription it belongs to.
   *
   * `tx`: optional transaction client — REQUIRED when `orderId` refers
   * to an `Order` created earlier in the SAME still-open transaction
   * (`PaymentsWebhookService.findOrCreateOrderForPayment`'s renewal-
   * order branch): `this.prisma` is a different connection than `tx`,
   * so writing a `Payment` row through it would try to satisfy
   * `payments_order_id_fkey` against a row that, from that OTHER
   * connection's point of view, doesn't exist yet (found live — a real
   * `P2003` foreign-key violation, not a hypothetical). Omitted
   * everywhere the order was already committed before this call
   * (`OrdersService.startProviderSubscription`, called strictly after
   * its own transaction commits).
   */
  async recordFromGateway(orderId: string, payment: GatewayPayment, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.payment.upsert({
      where: { id: payment.id },
      create: {
        id: payment.id,
        orderId,
        status: payment.status,
        statusDetail: payment.statusDetail,
        // A real Asaas payment always carries a value — null here would
        // mean the provider response itself is malformed, not a normal
        // case; 0 is a safe, honest fallback (never treated as a match
        // against a real order.amountCents).
        amountCents: payment.amountCents ?? 0,
        paidAmountCents: payment.paidAmountCents,
        currency: payment.currency ?? 'BRL',
        paymentMethodId: payment.paymentMethodId,
        // No `paymentTypeId` equivalent since the Asaas migration —
        // Asaas has one `billingType` field, not MP's separate method-
        // vs-type split. Column kept (legacy Mercado Pago rows still
        // populate it), just never written by new rows.
        paymentTypeId: null,
        installments: payment.installments,
        approvedAt: payment.approvedAt,
        raw: payment.raw as Prisma.InputJsonValue,
      },
      update: {
        status: payment.status,
        statusDetail: payment.statusDetail,
        paidAmountCents: payment.paidAmountCents,
        installments: payment.installments,
        approvedAt: payment.approvedAt,
        raw: payment.raw as Prisma.InputJsonValue,
      },
    });
  }
}
