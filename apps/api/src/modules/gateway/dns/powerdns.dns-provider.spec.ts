import { ConfigService } from '@nestjs/config';
import { PowerDnsProvider } from './powerdns.dns-provider';

/** Same "mock global.fetch, resolve/reject per test" convention as cloudflare.dns-provider.spec.ts. */
function mockFetchOnce(body: unknown, ok = true, status = ok ? 200 : 500): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    PUBLIC_GATEWAY_DNS_API_URL: 'http://10.10.0.1:8081',
    PUBLIC_GATEWAY_DNS_API_TOKEN: 'test-key',
    PUBLIC_GATEWAY_HOSTNAME_ZONE: 'mc.gxhost.com.br',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('PowerDnsProvider', () => {
  let provider: PowerDnsProvider;

  beforeEach(() => {
    provider = new PowerDnsProvider(makeConfig());
    global.fetch = jest.fn();
  });

  describe('ensureSrv', () => {
    it('PATCHes a REPLACE rrset with the RFC 2782 content format, in one call (no find-first)', async () => {
      mockFetchOnce({}, true, 204);

      await provider.ensureSrv({ hostname: 'survival.mc.gxhost.com.br', target: 'gateway.gxhost.com.br', port: 25566 });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/zones/mc.gxhost.com.br.');
      expect(init.method).toBe('PATCH');
      const payload = JSON.parse(init.body);
      expect(payload.rrsets).toEqual([
        {
          name: '_minecraft._tcp.survival.mc.gxhost.com.br.',
          type: 'SRV',
          changetype: 'REPLACE',
          ttl: 60,
          records: [{ content: '0 0 25566 gateway.gxhost.com.br.', disabled: false }],
        },
      ]);
    });

    it('defaults the server id to "localhost" when PUBLIC_GATEWAY_DNS_SERVER_ID is unset', async () => {
      mockFetchOnce({}, true, 204);
      await provider.ensureSrv({ hostname: 'survival.mc.gxhost.com.br', target: 'gateway.gxhost.com.br', port: 25566 });
      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/servers/localhost/');
    });
  });

  describe('removeSrv', () => {
    it('PATCHes a DELETE changetype with no ttl/records', async () => {
      mockFetchOnce({}, true, 204);
      await provider.removeSrv('survival.mc.gxhost.com.br');
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      const payload = JSON.parse(init.body);
      expect(payload.rrsets).toEqual([{ name: '_minecraft._tcp.survival.mc.gxhost.com.br.', type: 'SRV', changetype: 'DELETE' }]);
    });
  });

  describe('ensureAddressRecord', () => {
    it('creates an A record for an IPv4 literal', async () => {
      mockFetchOnce({}, true, 204);
      await provider.ensureAddressRecord({ hostname: 'survival.mc.gxhost.com.br', ip: '203.0.113.50' });
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body).rrsets[0]).toMatchObject({ type: 'A', records: [{ content: '203.0.113.50', disabled: false }] });
    });

    it('creates an AAAA record for an IPv6 literal', async () => {
      mockFetchOnce({}, true, 204);
      await provider.ensureAddressRecord({ hostname: 'survival.mc.gxhost.com.br', ip: '2001:db8::1' });
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body).rrsets[0]).toMatchObject({ type: 'AAAA' });
    });

    it('skips silently (no API call) when the address is not a literal IP', async () => {
      await provider.ensureAddressRecord({ hostname: 'survival.mc.gxhost.com.br', ip: 'gateway.example.com' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('removeAddressRecord', () => {
    it('DELETEs both A and AAAA rrsets unconditionally, in one call — no find-first needed', async () => {
      mockFetchOnce({}, true, 204);
      await provider.removeAddressRecord('survival.mc.gxhost.com.br');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body).rrsets).toEqual([
        { name: 'survival.mc.gxhost.com.br.', type: 'A', changetype: 'DELETE' },
        { name: 'survival.mc.gxhost.com.br.', type: 'AAAA', changetype: 'DELETE' },
      ]);
    });
  });

  describe('isHostnameAvailable', () => {
    it('returns false when a record already exists at that exact name', async () => {
      mockFetchOnce({ rrsets: [{ name: 'api.mc.gxhost.com.br.', type: 'A', records: [{ content: '203.0.113.1' }] }] });
      await expect(provider.isHostnameAvailable('api.mc.gxhost.com.br')).resolves.toBe(false);
    });

    it('returns true when no record exists at that name', async () => {
      mockFetchOnce({ rrsets: [] });
      await expect(provider.isHostnameAvailable('survival.mc.gxhost.com.br')).resolves.toBe(true);
    });

    it('ignores an rrset with no records (an empty/tombstoned entry)', async () => {
      mockFetchOnce({ rrsets: [{ name: 'survival.mc.gxhost.com.br.', type: 'A', records: [] }] });
      await expect(provider.isHostnameAvailable('survival.mc.gxhost.com.br')).resolves.toBe(true);
    });

    it('fails OPEN (resolves true, never throws) when the PowerDNS API call itself errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(provider.isHostnameAvailable('survival.mc.gxhost.com.br')).resolves.toBe(true);
    });

    it('fails OPEN when PowerDNS responds with a non-2xx status', async () => {
      mockFetchOnce('internal error', false, 500);
      await expect(provider.isHostnameAvailable('survival.mc.gxhost.com.br')).resolves.toBe(true);
    });
  });

  describe('configuration', () => {
    it('throws ServiceUnavailableException when PUBLIC_GATEWAY_DNS_API_URL is not configured', async () => {
      const unconfigured = new PowerDnsProvider(makeConfig({ PUBLIC_GATEWAY_DNS_API_URL: '' }));
      await expect(unconfigured.ensureSrv({ hostname: 'x.mc.gxhost.com.br', target: 'gw.gxhost.com.br', port: 1 })).rejects.toThrow(
        'PUBLIC_GATEWAY_DNS_API_URL is not configured',
      );
    });

    it('throws ServiceUnavailableException when PUBLIC_GATEWAY_HOSTNAME_ZONE is not configured', async () => {
      const unconfigured = new PowerDnsProvider(makeConfig({ PUBLIC_GATEWAY_HOSTNAME_ZONE: '' }));
      await expect(unconfigured.ensureSrv({ hostname: 'x.mc.gxhost.com.br', target: 'gw.gxhost.com.br', port: 1 })).rejects.toThrow(
        'PUBLIC_GATEWAY_HOSTNAME_ZONE is not configured',
      );
    });
  });
});
