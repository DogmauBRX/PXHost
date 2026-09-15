/**
 * Pure address-composition helpers — no I/O, no Prisma. Kept separate
 * from GatewayService so ServerView (and a unit test) can derive the
 * SAME string a customer sees without touching the database.
 *
 * Hostname pattern chosen: `<shortId>.mc.<zone>`, not `mc-<id>.<zone>`.
 * The reason is DNS operations, not taste: a single wildcard record
 * (`*.mc.<zone>` -> the gateway's public IP) covers every current and
 * future server with zero per-server DNS automation — `mc-<id>` would
 * work identically for a wildcard too, but `<id>.mc.<zone>` reads as
 * "this id, under the mc subdomain" and leaves `<zone>`'s own apex free
 * for anything else. `shortId` (not the server's uuid) because it's
 * already this platform's public-facing identifier — the one in the
 * URL, the one support asks a customer for.
 */

/** Lowercase — DNS is case-insensitive but a customer pasting `MC-ABC123` into a client should still resolve the same host a lowercase wildcard record answers for. */
export function deriveHostname(shortId: string, zone: string): string {
  return `${shortId.toLowerCase()}.mc.${zone}`;
}

/**
 * `zone` is optional: with no `PUBLIC_GATEWAY_HOSTNAME_ZONE` configured
 * (the default), a server's public address falls back to the gateway's
 * own `publicHost:port` — no DNS involved at all. This is deliberate:
 * `docs/PUBLIC-EXPOSURE.md`'s dev/first-boot path never requires owning
 * a domain.
 */
export function derivePublicAddress(gatewayPublicHost: string, shortId: string, publicPort: number, zone?: string | null): string {
  const host = zone ? deriveHostname(shortId, zone) : gatewayPublicHost;
  return `${host}:${publicPort}`;
}
