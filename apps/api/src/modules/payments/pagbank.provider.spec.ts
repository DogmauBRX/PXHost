import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PagBankProvider, classifyPagBankPayment, classifyPagBankSubscription } from './pagbank.provider';

describe('PagBankProvider', () => {
  it('exposes card only after recurring payments are explicitly enabled', () => {
    const client = { isConfigured: jest.fn().mockReturnValue(true) };
    const disabled = new PagBankProvider(client as any, { get: jest.fn().mockReturnValue(false) } as any);
    const enabled = new PagBankProvider(client as any, { get: jest.fn().mockReturnValue(true) } as any);

    expect(disabled.supportedPaymentMethods()).toEqual(['pix', 'boleto']);
    expect(enabled.supportedPaymentMethods()).toEqual(['pix', 'boleto', 'card']);
  });

  it('creates a boleto order with holder address and exposes the PDF and digitable line', async () => {
    const post = jest.fn().mockResolvedValue({
      id: 'ORDE_1',
      charges: [{
        id: 'CHAR_1',
        reference_id: 'ord_test',
        status: 'WAITING',
        amount: { value: 5190, currency: 'BRL' },
        payment_method: {
          type: 'BOLETO',
          boleto: {
            due_date: '2026-09-28',
            barcode: '123456',
            formatted_barcode: '12345.67890 12345.678901 1 12340000005190',
          },
        },
        links: [{ rel: 'SELF', media: 'application/pdf', href: 'https://api.pagseguro.com/charges/CHAR_1/boleto.pdf' }],
      }],
    });
    const client = { post, isConfigured: jest.fn().mockReturnValue(true) };
    const config = { get: jest.fn((key: string) => key === 'PUBLIC_SITE_URL' ? 'https://gxhost.example' : undefined) };
    const provider = new PagBankProvider(client as any, config as any);

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
      '/orders',
      expect.objectContaining({
        charges: [expect.objectContaining({ payment_method: expect.objectContaining({ type: 'BOLETO' }) })],
      }),
      'order-1',
    );
    expect(charge.ticketUrl).toContain('boleto.pdf');
    expect(charge.digitableLine).toContain('12345.67890');
  });

  it('maps PagBank payment and subscription statuses into domain outcomes', () => {
    expect(classifyPagBankPayment('PAID')).toBe('PaymentConfirmed');
    expect(classifyPagBankPayment('WAITING')).toBe('PaymentPending');
    expect(classifyPagBankPayment('DECLINED')).toBe('PaymentFailed');
    expect(classifyPagBankPayment('REFUNDED')).toBe('PaymentRefunded');
    expect(classifyPagBankSubscription('ACTIVE')).toBe('SubscriptionSynced');
    expect(classifyPagBankSubscription('OVERDUE')).toBe('SubscriptionPastDue');
    expect(classifyPagBankSubscription('CANCELED')).toBe('SubscriptionCanceled');
  });

  it('verifies the original payload with PagBank ECDSA and extracts the changed charge', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const rawBody = Buffer.from(JSON.stringify({ id: 'ORDE_1', charges: [{ id: 'CHAR_1', status: 'PAID' }] }));
    const signature = sign('sha256', rawBody, privateKey).toString('base64');
    const client = {
      get: jest.fn().mockResolvedValue({ public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    const provider = new PagBankProvider(client as any, { get: jest.fn() } as any);

    const parsed = await provider.parseWebhook({
      headers: { 'x-payload-signature': signature },
      query: {},
      body: JSON.parse(rawBody.toString('utf8')),
      rawBody,
    });

    expect(parsed.resourceKind).toBe('payment');
    expect(parsed.resourceId).toBe('CHAR_1');
    expect(parsed.rawEvent).toBe('charge.paid');
    expect(client.get).toHaveBeenCalledWith('/public-keys?type=webhook');
  });

  it('rejects a signature that does not match the raw body', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const rawBody = Buffer.from('{"id":"ORDE_1"}');
    const signature = sign('sha256', Buffer.from('{"id":"ORDE_2"}'), privateKey).toString('base64');
    const client = {
      get: jest.fn().mockResolvedValue({ public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    const provider = new PagBankProvider(client as any, { get: jest.fn() } as any);

    await expect(provider.parseWebhook({ headers: { 'x-payload-signature': signature }, query: {}, body: {}, rawBody })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
