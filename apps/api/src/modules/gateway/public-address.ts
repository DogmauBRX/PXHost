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
 * Custom-hostname plan — a customer-CHOSEN label, under the same `.mc.`
 * subdomain as `deriveHostname` above ("survival" + "gxhost.com.br" ->
 * "survival.mc.gxhost.com.br").
 *
 * This used to compose the label directly under the apex
 * ("survival.gxhost.com.br"), on the reasoning that the customer's own
 * examples are bare subdomains. That was written before the DNS
 * topology was settled, and the two turned out to be incompatible: the
 * platform is authoritative for `mc.<zone>` ALONE — the apex stays with
 * whoever already serves the site, panel and API — so a name at the
 * apex is one this platform cannot publish at all.
 *
 * It failed in the worst possible way rather than loudly. DNS sync is
 * best-effort by design, so the provider's refusal was logged and
 * swallowed; the panel accepted the hostname, displayed it as the
 * connection address, and the customer could never connect to it. Found
 * live, on a real server.
 *
 * Unlike `shortId` (permanent, never reused) this label can change or be
 * released and reused by someone else, which is why it still needs
 * per-record DNS lifecycle rather than the `.mc.` scheme's single static
 * wildcard — see hostname-policy.ts and GatewayService's own doc
 * comments.
 */
export function deriveCustomHostname(label: string, zone: string): string {
  return `${label.toLowerCase()}.mc.${zone}`;
}

/**
 * `zone` is optional: with no `PUBLIC_GATEWAY_HOSTNAME_ZONE` configured
 * (the default), a server's public address falls back to the gateway's
 * own `publicHost:port` — no DNS involved at all. This is deliberate:
 * `docs/PUBLIC-EXPOSURE.md`'s dev/first-boot path never requires owning
 * a domain.
 *
 * `dnsAutomationActive` drops the `:port` suffix, which is the entire
 * point of the `_minecraft._tcp` SRV record the gateway publishes: the
 * client looks the SRV up itself and learns the port, so the customer
 * only ever has to type the hostname. Without it the address stays
 * `host:port` — still correct and connectable (the A record answers on
 * that exact port), just not what the SRV record was published for.
 *
 * Gated on automation being ACTIVE rather than on `zone` alone because a
 * zone can be configured while the provider is still `none`: the
 * hostname then resolves via a static wildcard with no SRV record behind
 * it, and hiding the port there would hand the customer an address that
 * silently fails to connect.
 */
export function derivePublicAddress(
  gatewayPublicHost: string,
  shortId: string,
  publicPort: number,
  zone?: string | null,
  dnsAutomationActive = false,
): string {
  if (!zone) return `${gatewayPublicHost}:${publicPort}`;
  const host = deriveHostname(shortId, zone);
  return dnsAutomationActive ? host : `${host}:${publicPort}`;
}
