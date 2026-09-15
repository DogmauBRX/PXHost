import { describeSoftware } from '../templates/software';
import { derivePublicAddress } from '../gateway/public-address';

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
  publicRoute?: { publicPort: number; state: string; gateway: { publicHost: string } } | null;
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
 */
export function toClientServerSummary<T extends ServerWithTemplate>(row: T, zone?: string | null) {
  const { publicRoute, ...rest } = row;
  const publicAddress =
    publicRoute && publicRoute.state === 'active'
      ? derivePublicAddress(publicRoute.gateway.publicHost, row.shortId, publicRoute.publicPort, zone)
      : null;
  return { ...rest, software: describeSoftware(row.template?.softwareKind ?? null), publicAddress };
}

export function toClientServerDetail<T extends ServerWithTemplate>(
  row: T,
  role: 'owner' | 'subuser' | 'admin',
  permissions: string[],
  zone?: string | null,
) {
  return { ...toClientServerSummary(row, zone), role, permissions };
}
