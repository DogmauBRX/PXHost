import { ConfigService } from '@nestjs/config';
import { CloudflareDnsProvider } from './cloudflare.dns-provider';

/** Same "mock global.fetch, resolve/reject per test" convention as software-discovery.service.spec.ts. */
function mockFetchOnce(body: unknown, ok = true): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok, status: ok ? 200 : 500, json: async () => body });
}

function makeConfig(): ConfigService {
  const values: Record<string, string> = {
    PUBLIC_GATEWAY_DNS_API_TOKEN: 'test-token',
    PUBLIC_GATEWAY_DNS_ZONE_ID: 'zone-123',
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('CloudflareDnsProvider', () => {
  let provider: CloudflareDnsProvider;

  beforeEach(() => {
    provider = new CloudflareDnsProvider(makeConfig());
    global.fetch = jest.fn();
  });

  describe('ensureAddressRecord', () => {
    it('creates an A record for an IPv4 literal', async () => {
      mockFetchOnce({ success: true, result: [] }); // findRecord: none existing
      mockFetchOnce({ success: true, result: { id: 'rec1' } }); // POST create

      await provider.ensureAddressRecord({ hostname: 'survival.gxhost.com.br', ip: '203.0.113.50' });

      const postCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(postCall[0]).toContain('/dns_records');
      expect(postCall[1].method).toBe('POST');
      expect(JSON.parse(postCall[1].body)).toMatchObject({ type: 'A', content: '203.0.113.50' });
    });

    it('creates an AAAA record for an IPv6 literal', async () => {
      mockFetchOnce({ success: true, result: [] });
      mockFetchOnce({ success: true, result: { id: 'rec1' } });

      await provider.ensureAddressRecord({ hostname: 'survival.gxhost.com.br', ip: '2001:db8::1' });

      const postCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(JSON.parse(postCall[1].body)).toMatchObject({ type: 'AAAA', content: '2001:db8::1' });
    });

    it('skips silently (no API call) when the address is not a literal IP — e.g. Gateway.publicHost configured as a hostname', async () => {
      await provider.ensureAddressRecord({ hostname: 'survival.gxhost.com.br', ip: 'gateway.example.com' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('PATCHes an existing record instead of creating a duplicate', async () => {
      mockFetchOnce({ success: true, result: [{ id: 'existing-1', name: 'survival.gxhost.com.br', type: 'A' }] });
      mockFetchOnce({ success: true, result: { id: 'existing-1' } });

      await provider.ensureAddressRecord({ hostname: 'survival.gxhost.com.br', ip: '203.0.113.50' });

      const secondCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(secondCall[0]).toContain('/dns_records/existing-1');
      expect(secondCall[1].method).toBe('PATCH');
    });
  });

  describe('isHostnameAvailable', () => {
    it('returns false when a record already exists at that exact name', async () => {
      mockFetchOnce({ success: true, result: [{ id: 'r1', name: 'api.gxhost.com.br', type: 'A' }] });
      await expect(provider.isHostnameAvailable('api.gxhost.com.br')).resolves.toBe(false);
    });

    it('returns true when no record exists', async () => {
      mockFetchOnce({ success: true, result: [] });
      await expect(provider.isHostnameAvailable('survival.gxhost.com.br')).resolves.toBe(true);
    });

    it('fails OPEN (resolves true, never throws) when the Cloudflare API call itself errors — an unrelated outage must never block a customer save', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(provider.isHostnameAvailable('survival.gxhost.com.br')).resolves.toBe(true);
    });

    it('fails OPEN when Cloudflare responds with a non-2xx/success:false', async () => {
      mockFetchOnce({ success: false, errors: ['boom'] }, false);
      await expect(provider.isHostnameAvailable('survival.gxhost.com.br')).resolves.toBe(true);
    });
  });

  describe('removeAddressRecord', () => {
    it('no-ops when neither an A nor an AAAA record exists', async () => {
      mockFetchOnce({ success: true, result: [] }); // A lookup
      mockFetchOnce({ success: true, result: [] }); // AAAA lookup
      await provider.removeAddressRecord('survival.gxhost.com.br');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('deletes the record when found', async () => {
      mockFetchOnce({ success: true, result: [{ id: 'rec1', name: 'survival.gxhost.com.br', type: 'A' }] });
      mockFetchOnce({ success: true, result: { id: 'rec1' } });
      await provider.removeAddressRecord('survival.gxhost.com.br');
      const deleteCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(deleteCall[1].method).toBe('DELETE');
    });
  });
});
