import { deriveCustomHostname, deriveHostname, derivePublicAddress } from './public-address';
import { isReservedHostnameLabel } from './hostname-policy';

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
  /**
   * This used to compose at the apex ("survival.gxhost.com.br"). The
   * platform is authoritative for `mc.<zone>` alone — the apex belongs
   * to whoever serves the site — so an apex name is one it cannot
   * publish, and a customer who set one got an address the panel showed
   * and no client could resolve. Found live.
   */
  it('compõe sob o mesmo .mc. dos automáticos, que é a zona que a plataforma realmente controla', () => {
    expect(deriveCustomHostname('survival', 'gxhost.com.br')).toBe('survival.mc.gxhost.com.br');
  });

  it('lowercases the label the same way deriveHostname lowercases shortId', () => {
    expect(deriveCustomHostname('SURVIVAL', 'gxhost.com.br')).toBe('survival.mc.gxhost.com.br');
  });

  /**
   * The cost of sharing one namespace with the automatic hostnames: a
   * label CAN now be composed into the same name as some server's
   * `<shortId>.mc.<zone>`. Nothing in this pure function can prevent
   * that — it is held off by hostname-policy reserving shortId-SHAPED
   * labels, plus the live availability check. This test pins the
   * overlap so the reason those guards exist stays visible here.
   */
  it('divide o namespace com deriveHostname — a colisão é possível e é barrada em outro lugar', () => {
    const zone = 'gxhost.com.br';
    expect(deriveCustomHostname('tdafy4cn', zone)).toBe(deriveHostname('TDAFY4CN', zone));
    expect(isReservedHostnameLabel('tdafy4cn')).toBe(true);
  });
});
