import { deriveHostname, derivePublicAddress } from './public-address';

describe('deriveHostname', () => {
  it('composes <shortid>.mc.<zone>, not mc-<id>.<zone> (the wildcard-DNS pattern this module\'s doc comment commits to)', () => {
    expect(deriveHostname('8qm6c31e', 'gxhost.com.br')).toBe('8qm6c31e.mc.gxhost.com.br');
  });

  it('lowercases the shortId so a customer pasting an uppercase id still resolves the lowercase wildcard record', () => {
    expect(deriveHostname('8QM6C31E', 'gxhost.com.br')).toBe('8qm6c31e.mc.gxhost.com.br');
  });
});

describe('derivePublicAddress', () => {
  it('with a zone configured, prefers the derived hostname over the gateway\'s own publicHost', () => {
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566, 'gxhost.com.br')).toBe('abc123.mc.gxhost.com.br:25566');
  });

  it('with no zone (PUBLIC_GATEWAY_HOSTNAME_ZONE unset — the default), falls back to gatewayPublicHost:port with zero DNS involved', () => {
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566)).toBe('203.0.113.50:25566');
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566, null)).toBe('203.0.113.50:25566');
  });
});
