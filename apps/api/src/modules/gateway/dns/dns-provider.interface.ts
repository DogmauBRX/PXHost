/**
 * Optional SRV automation (public-exposure plan §4/§15) — separate seam
 * from `GatewayDriver` on purpose: a driver always runs (it's what
 * actually opens the port), a DNS provider is opt-in and, by default,
 * does nothing. `_minecraft._tcp.<hostname>` SRV lets a client connect
 * WITHOUT a port (`mc-abc123.gxhost.com.br` instead of `...:25566`) —
 * a nice-to-have, never required for the feature to work.
 */
export const DNS_PROVIDER = Symbol('DNS_PROVIDER');

export interface SrvRecordInput {
  /** e.g. "8qm6c31e.mc.gxhost.com.br" — the record this SRV entry is FOR, never the zone apex. */
  hostname: string;
  target: string;
  port: number;
}

export interface DnsProvider {
  ensureSrv(input: SrvRecordInput): Promise<void>;
  removeSrv(hostname: string): Promise<void>;
}
