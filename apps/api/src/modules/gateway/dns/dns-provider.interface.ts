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

/** Custom-hostname plan — the A/AAAA record for a hostname itself (SRV's `target` still points at `Gateway.publicHost`, this is what makes the bare hostname resolve to something at all). */
export interface AddressRecordInput {
  hostname: string;
  /** Raw IPv4 or IPv6 literal — `Gateway.publicHost` today. */
  ip: string;
}

export interface DnsProvider {
  ensureSrv(input: SrvRecordInput): Promise<void>;
  removeSrv(hostname: string): Promise<void>;
  /** Best-effort A/AAAA automation for a custom hostname — same "never blocks a route's state" posture as ensureSrv. */
  ensureAddressRecord(input: AddressRecordInput): Promise<void>;
  removeAddressRecord(hostname: string): Promise<void>;
  /** Live conflict check for a candidate hostname, on top of the static reserved-word list (hostname-policy.ts). MUST fail OPEN (resolve true) on any network/API error — an unrelated DNS provider outage must never block a customer's save. */
  isHostnameAvailable(hostname: string): Promise<boolean>;
  /**
   * Whether this provider is able to publish `hostname` at all — a
   * question about configuration, not about the network, so it is
   * synchronous and must never do I/O.
   *
   * Distinct from `isHostnameAvailable`, which asks whether a name is
   * FREE and deliberately fails open. This one asks whether the name is
   * even ours to write, and a `false` here is permanent: retrying,
   * waiting, or a provider coming back online will not change it.
   *
   * It exists because the alternative was found live: a customer saved a
   * custom hostname outside the delegated zone, the save succeeded, the
   * panel showed it as the connection address, and the reconciler then
   * failed to publish it every 30 seconds into a log nobody reads.
   * Best-effort DNS sync is right for an outage; it is the wrong answer
   * for a name that can never work.
   */
  canPublish(hostname: string): boolean;
}
