import { deriveCustomHostname, deriveHostname, derivePublicAddress } from './public-address';

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

  it('drops the port once DNS automation is active — the whole point of the published SRV record', () => {
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566, 'gxhost.com.br', true)).toBe('abc123.mc.gxhost.com.br');
  });

  /**
   * A zone can be configured while the provider is still `none`: the
   * hostname resolves via a static wildcard, but no SRV record exists to
   * carry the port. Hiding it there would hand the customer an address
   * that silently refuses to connect.
   */
  it('keeps the port when a zone is configured but DNS automation is off', () => {
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566, 'gxhost.com.br', false)).toBe('abc123.mc.gxhost.com.br:25566');
  });

  it('never hides the port when there is no zone at all, whatever automation says', () => {
    expect(derivePublicAddress('203.0.113.50', 'abc123', 25566, null, true)).toBe('203.0.113.50:25566');
  });
});

describe('deriveCustomHostname', () => {
  it('composes <label>.<zone> directly under the apex — never nested under deriveHostname\'s .mc. namespace', () => {
    expect(deriveCustomHostname('survival', 'gxhost.com.br')).toBe('survival.gxhost.com.br');
  });

  it('lowercases the label the same way deriveHostname lowercases shortId', () => {
    expect(deriveCustomHostname('SURVIVAL', 'gxhost.com.br')).toBe('survival.gxhost.com.br');
  });

  it('never collides with deriveHostname\'s output for the same zone', () => {
    const zone = 'gxhost.com.br';
    expect(deriveCustomHostname('mc', zone)).not.toBe(deriveHostname('mc', zone));
  });
});
