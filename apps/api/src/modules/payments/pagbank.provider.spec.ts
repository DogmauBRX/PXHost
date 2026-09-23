import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PagBankProvider, classifyPagBankPayment, classifyPagBankSubscription } from './pagbank.provider';

describe('PagBankProvider', () => {
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
