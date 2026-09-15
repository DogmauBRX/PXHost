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
  publicRoute?: { publicPort: number; state: string; customHostname: string | null; gateway: { publicHost: string } } | null;
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
 * Custom-hostname plan: when a customer has set `customHostname`, it's
 * preferred over the shortId-derived `.mc.` scheme. The port is only
 * dropped from the displayed address when `dnsAutomationActive` — SRV
 * is what actually makes "no port" true, so a hostname reserved while
 * DNS automation is off (or a deployment that never turned it on) still
 * shows `hostname:port`, never implies a promise the SRV record can't
 * keep.
 */
export function toClientServerSummary<T extends ServerWithTemplate>(row: T, zone?: string | null, dnsAutomationActive = false) {
  const { publicRoute, ...rest } = row;
  const customHostname = publicRoute?.customHostname ?? null;
  let publicAddress: string | null = null;
  if (publicRoute && publicRoute.state === 'active') {
    if (customHostname && zone) {
      const host = deriveCustomHostname(customHostname, zone);
      publicAddress = dnsAutomationActive ? host : `${host}:${publicRoute.publicPort}`;
    } else {
      publicAddress = derivePublicAddress(publicRoute.gateway.publicHost, row.shortId, publicRoute.publicPort, zone);
    }
  }
  return { ...rest, software: describeSoftware(row.template?.softwareKind ?? null), publicAddress, customHostname };
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
