import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MercadoPagoProvider } from './mercadopago.provider';
import type { MercadoPagoClient } from './mercadopago.client';
import type { WebhookRequestInput } from './payment-provider.interface';

const SECRET = 'test-webhook-secret';
const TS = '1704908010';
const REQUEST_ID = 'req-abc-123';

function providerWith(secret: string | undefined): MercadoPagoProvider {
  const config = {
    get: (key: string) => (key === 'MERCADOPAGO_WEBHOOK_SECRET' ? secret : undefined),
  } as unknown as ConfigService;
  return new MercadoPagoProvider({} as MercadoPagoClient, config);
}

/** The manifest Mercado Pago's docs specify, built by hand here so the test asserts the FORMAT rather than mirroring the implementation. */
function sign(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function request(overrides: {
  dataId?: string | null;
  requestId?: string | null;
  signature?: string;
  ts?: string;
  body?: unknown;
}): WebhookRequestInput {
  const headers: Record<string, string | string[] | undefined> = {};
  if (overrides.requestId !== null) headers['x-request-id'] = overrides.requestId ?? REQUEST_ID;
  if (overrides.signature !== undefined) headers['x-signature'] = overrides.signature;
  const query: Record<string, string | string[] | undefined> = {};
  if (overrides.dataId !== null) query['data.id'] = overrides.dataId ?? 'payment-1';
  return { headers, query, body: overrides.body ?? { id: 99, type: 'payment', action: 'payment.updated', data: { id: overrides.dataId ?? 'payment-1' } } };
}

/**
 * The webhook signature check is the ONLY authentication this platform's
 * payment webhook has, and the e2e suite deliberately bypasses it (its
 * fake provider stands in for the whole provider). So it is verified
 * here, directly, against the manifest format Mercado Pago documents:
 *
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 */
describe('MercadoPagoProvider.parseWebhook signature verification', () => {
  it('accepts a notification signed over the documented manifest', () => {
    const manifest = `id:payment-1;request-id:${REQUEST_ID};ts:${TS};`;
    const parsed = providerWith(SECRET).parseWebhook(request({ signature: `ts=${TS},v1=${sign(manifest)}` }));

    expect(parsed.resourceKind).toBe('payment');
    expect(parsed.resourceId).toBe('payment-1');
    expect(parsed.notificationId).toBe('99');
  });

  it('lowercases an uppercase data.id before hashing, as the docs require', () => {
    // Signed over the LOWERCASED id — the provider must reproduce that
    // even though the id arrives uppercase.
    const manifest = `id:abc-def;request-id:${REQUEST_ID};ts:${TS};`;
    const parsed = providerWith(SECRET).parseWebhook(request({ dataId: 'ABC-DEF', signature: `ts=${TS},v1=${sign(manifest)}` }));
    expect(parsed.resourceId).toBe('ABC-DEF'); // reported verbatim; only the MANIFEST is lowercased
  });

  it('omits an absent segment from the manifest entirely rather than leaving it empty', () => {
    // No x-request-id header at all: the `request-id:` segment must not
    // appear. A manifest with an empty segment would produce a different
    // hash and reject a legitimate notification.
    const manifest = `id:payment-1;ts:${TS};`;
    const parsed = providerWith(SECRET).parseWebhook(request({ requestId: null, signature: `ts=${TS},v1=${sign(manifest)}` }));
    expect(parsed.resourceId).toBe('payment-1');
  });

  it('rejects a signature computed with the wrong secret', () => {
    const manifest = `id:payment-1;request-id:${REQUEST_ID};ts:${TS};`;
    expect(() => providerWith(SECRET).parseWebhook(request({ signature: `ts=${TS},v1=${sign(manifest, 'not-the-secret')}` }))).toThrow(UnauthorizedException);
  });

  it('rejects a signature over a DIFFERENT resource id (a captured notification replayed against another payment)', () => {
    const manifest = `id:some-other-payment;request-id:${REQUEST_ID};ts:${TS};`;
    expect(() => providerWith(SECRET).parseWebhook(request({ signature: `ts=${TS},v1=${sign(manifest)}` }))).toThrow(UnauthorizedException);
  });

  it('rejects a missing or malformed x-signature header', () => {
    expect(() => providerWith(SECRET).parseWebhook(request({}))).toThrow(UnauthorizedException);
    expect(() => providerWith(SECRET).parseWebhook(request({ signature: 'garbage' }))).toThrow(UnauthorizedException);
  });

  it('refuses everything when no webhook secret is configured — an unverifiable notification is never trusted', () => {
    const manifest = `id:payment-1;request-id:${REQUEST_ID};ts:${TS};`;
    expect(() => providerWith(undefined).parseWebhook(request({ signature: `ts=${TS},v1=${sign(manifest)}` }))).toThrow(UnauthorizedException);
  });

  it('maps each subscribed topic to the resource the webhook service must re-fetch', () => {
    const provider = providerWith(SECRET);
    const signedFor = (type: string) => {
      const manifest = `id:res-1;request-id:${REQUEST_ID};ts:${TS};`;
      return provider.parseWebhook(
        request({ dataId: 'res-1', signature: `ts=${TS},v1=${sign(manifest)}`, body: { id: 1, type, action: `${type}.updated`, data: { id: 'res-1' } } }),
      );
    };

    expect(signedFor('payment').resourceKind).toBe('payment');
    expect(signedFor('subscription_preapproval').resourceKind).toBe('preapproval');
    expect(signedFor('subscription_authorized_payment').resourceKind).toBe('authorized_payment');
    // A topic this platform doesn't handle is acknowledged, not acted on.
    expect(signedFor('subscription_preapproval_plan').resourceKind).toBeNull();
  });
});

describe('MercadoPagoProvider boleto', () => {
  it('creates bolbradesco through the payment endpoint and returns its hosted ticket', async () => {
    const post = jest.fn().mockResolvedValue({
      id: 123,
      status: 'pending',
      status_detail: 'pending_waiting_payment',
      external_reference: 'ord_test',
      transaction_amount: 51.9,
      transaction_details: {
        total_paid_amount: 0,
        external_resource_url: 'https://www.mercadopago.com.br/payments/123/ticket',
      },
      barcode: { content: '23793380296060054351030006333303799140000020000' },
      currency_id: 'BRL',
      payment_method_id: 'bolbradesco',
      payment_type_id: 'ticket',
      installments: 1,
      date_approved: null,
      date_of_expiration: '2026-09-28T23:59:59.000-03:00',
    });
    const config = { get: jest.fn((key: string) => key === 'PUBLIC_SITE_URL' ? 'https://gxhost.example' : undefined) };
    const provider = new MercadoPagoProvider({ post } as unknown as MercadoPagoClient, config as unknown as ConfigService);

    const charge = await provider.createBoletoCharge({
      payer: {
        userId: 'user-1',
        email: 'cliente@example.com',
        firstName: 'Cliente',
        lastName: 'GX',
        cpf: '12345678901',
        address: { postalCode: '01001000', addressLine: 'Praça da Sé', addressNumber: '1', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' },
      },
      amountCents: 5190,
      currency: 'BRL',
      description: 'Plano Avançado',
      externalReference: 'ord_test',
      idempotencyKey: 'order-1',
      expiresAt: new Date('2026-09-28T23:59:59.000-03:00'),
    });

    expect(post).toHaveBeenCalledWith(
      '/v1/payments',
      expect.objectContaining({ payment_method_id: 'bolbradesco', external_reference: 'ord_test' }),
      'order-1',
    );
    expect(charge.ticketUrl).toContain('/ticket');
    expect(charge.digitableLine).toBe('23793380296060054351030006333303799140000020000');
  });
});
