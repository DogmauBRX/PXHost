import { describeSoftware } from '../templates/software';
import { deriveCustomHostname, derivePublicAddress } from '../gateway/public-address';

/**
 * Response shaping for client-facing server payloads — deliberately kept
 * OUT of `ServerAccessService` (~10 consumers today; it resolves
 * ownership/permissions, it does not format a response) and out of the
 * agent-facing admin service (which has its own shape). Lives here,
 * next to the one controller that actually needs it.
 */

interface ServerWithTemplate {
  shortId: string;
  template: { softwareKind: string | null } | null;
  // Public-exposure plan — present only when ServerAccessService's
  // include picked it up; null/undefined both mean "not exposed",
  // exactly today's every-server behavior when no Gateway is configured.
  // customHostname (custom-hostname plan) is the raw label the customer
  // chose, or null — separate from `publicAddress` below, which is the
  // fully-composed, display-ready string.
  publicRoute?: {
    publicPort: number;
    state: string;
    customHostname: string | null;
    // What is actually PUBLISHED in DNS right now, as opposed to
    // `customHostname`, which is what the customer asked for. The two
    // differ whenever a publish has not succeeded (yet, or at all).
    dnsSyncedHostname?: string | null;
    gateway: { publicHost: string };
  } | null;
  // The MINECRAFT_VERSION row alone (ServerAccessService's include
  // already filters to just it) — absent entirely for a template that
  // never declared that variable, which `minecraftVersion` below turns
  // into null rather than a confusing empty array on the response.
  variables?: { value: string }[];
  [key: string]: unknown;
}

/**
 * `publicAddress` is null whenever there's no ACTIVE route — a
 * `pending`/`failed` one is deliberately not surfaced as a connectable
 * address (it may not actually be forwarding yet), so the panel falls
 * back to showing the internal `allocations[].ip:port` it always has,
 * never a half-configured public one. `zone` comes from the caller
 * (PUBLIC_GATEWAY_HOSTNAME_ZONE) since this file has no ConfigService of
 * its own — see ClientServersService's call sites.
 *
 * The port is only dropped from the displayed address when
 * `dnsAutomationActive` — SRV is what actually makes "no port" true, so
 * a hostname reserved while DNS automation is off (or a deployment that
 * never turned it on) still shows `hostname:port`, never implies a
 * promise the SRV record can't keep. The same rule applies to the
 * shortId scheme: the gateway publishes an SRV for EVERY route, custom
 * hostname or not, so there is no reason for the branches to disagree
 * about the port.
 *
 * With DNS automation ON, the address shown is the one actually
 * PUBLISHED (`dnsSyncedHostname`) — never the one merely requested
 * (`customHostname`). Those are not the same question, and showing the
 * request was a real bug: a customer set a hostname the provider could
 * not publish, and the panel presented it as the connection address,
 * under a green "Conectado" badge, while no client on earth could
 * resolve it. When nothing is published the fallback is the gateway's
 * own `host:port`, which is ugly and always works — the opposite
 * trade-off from a pretty name that doesn't.
 */
export function toClientServerSummary<T extends ServerWithTemplate>(row: T, zone?: string | null, dnsAutomationActive = false) {
  const { publicRoute, variables, ...rest } = row;
  const minecraftVersion = variables?.[0]?.value ?? null;
  const customHostname = publicRoute?.customHostname ?? null;
  let publicAddress: string | null = null;
  if (publicRoute && publicRoute.state === 'active') {
    const published = publicRoute.dnsSyncedHostname ?? null;
    if (dnsAutomationActive) {
      publicAddress = published ?? `${publicRoute.gateway.publicHost}:${publicRoute.publicPort}`;
    } else if (customHostname && zone) {
      // Automation off: nothing is ever published, so dnsSyncedHostname
      // is always null and would tell us nothing. The label is answered
      // for by whatever static/wildcard DNS the operator set up, so it
      // is still the right thing to show — with the port, since no SRV
      // exists to supply it.
      publicAddress = `${deriveCustomHostname(customHostname, zone)}:${publicRoute.publicPort}`;
    } else {
      publicAddress = derivePublicAddress(publicRoute.gateway.publicHost, row.shortId, publicRoute.publicPort, zone, dnsAutomationActive);
    }
  }
  return { ...rest, software: describeSoftware(row.template?.softwareKind ?? null), publicAddress, customHostname, minecraftVersion };
}

export function toClientServerDetail<T extends ServerWithTemplate>(
  row: T,
  role: 'owner' | 'subuser' | 'admin',
  permissions: string[],
  zone?: string | null,
  dnsAutomationActive = false,
) {
  return { ...toClientServerSummary(row, zone, dnsAutomationActive), role, permissions };
}
