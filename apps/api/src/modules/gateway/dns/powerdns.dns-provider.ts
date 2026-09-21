import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIPv4, isIPv6 } from 'node:net';
import type { AddressRecordInput, DnsProvider, SrvRecordInput } from './dns-provider.interface';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long one fetched view of the zone may be reused to answer "is this
 * record already what I want?".
 *
 * GatewayService.reconcileOnce walks every route back to back, so a
 * few seconds is enough for one pass to read the zone once instead of
 * once per record, while staying far below the 30s between passes — a
 * record changed behind our back is still repaired on the next one.
 * Any write we make ourselves drops the snapshot immediately, so this
 * can never serve a view we know to be stale.
 */
const ZONE_SNAPSHOT_TTL_MS = 5_000;

interface PowerDnsRRSet {
  name: string;
  type: string;
  ttl?: number;
  records?: { content: string; disabled?: boolean }[];
}

interface PowerDnsZone {
  rrsets: PowerDnsRRSet[];
}

/**
 * Real SRV/A automation via a self-hosted PowerDNS Authoritative Server's
 * own REST API (GXhost's own ns1/ns2, authoritative for
 * `PUBLIC_GATEWAY_HOSTNAME_ZONE` — e.g. `mc.gxhost.com.br` — delegated
 * from the registrar; see docs/DNS-POWERDNS.md). Bound only when an
 * admin explicitly sets `PUBLIC_GATEWAY_DNS_PROVIDER=powerdns` (see
 * `gateway.module.ts`) — replaces `CloudflareDnsProvider` (removed) so
 * game-server DNS no longer depends on a third-party provider or its
 * commercial record quota; `gxhost.com.br` itself (site/painel/API) is
 * untouched and can stay wherever it already is.
 *
 * `PATCH .../zones/{zone}` with `changetype: "REPLACE"` is a genuine
 * upsert in ONE call — unlike Cloudflare's API, there is no
 * find-then-PATCH-or-POST dance needed for idempotency, and
 * `changetype: "DELETE"` on an rrset that doesn't exist is a documented
 * no-op, never an error (see removeAddressRecord below).
 */
@Injectable()
export class PowerDnsProvider implements DnsProvider {
  private readonly logger = new Logger(PowerDnsProvider.name);

  constructor(private readonly config: ConfigService) {}

  private apiUrl(): string {
    const url = this.config.get<string>('PUBLIC_GATEWAY_DNS_API_URL');
    if (!url) throw new ServiceUnavailableException('PUBLIC_GATEWAY_DNS_API_URL is not configured');
    return url.replace(/\/$/, '');
  }

  // Reused from the Cloudflare-era config — same "the currently-selected
  // DNS provider's API credential" role, just a different provider's key
  // now. Kept under the same name deliberately, to avoid a pointless env
  // rename on every deployment that already has this set.
  private apiKey(): string {
    const key = this.config.get<string>('PUBLIC_GATEWAY_DNS_API_TOKEN');
    if (!key) throw new ServiceUnavailableException('PUBLIC_GATEWAY_DNS_API_TOKEN is not configured');
    return key;
  }

  // PowerDNS's own convention: almost always the literal string
  // "localhost" (the server's own internal identifier, NOT a hostname to
  // connect to) — optional because every real deployment uses the
  // default.
  private serverId(): string {
    return this.config.get<string>('PUBLIC_GATEWAY_DNS_SERVER_ID') || 'localhost';
  }

  /**
   * The zone that actually EXISTS in PowerDNS and names its REST API's
   * `/zones/{zone}` path — deliberately its own setting, not reused from
   * PUBLIC_GATEWAY_HOSTNAME_ZONE.
   *
   * Those two are the same value only when the whole registrable apex is
   * delegated to this platform's nameservers. They diverge in the
   * recommended topology, and assuming otherwise was a real production
   * bug: `deriveHostname` composes `<shortId>.mc.<zone>` from the APEX
   * ("gxhost.com.br"), while PowerDNS is authoritative for the game
   * subdomain ALONE ("mc.gxhost.com.br") so the apex can keep serving the
   * site/panel/API from wherever it already lives. Patching
   * "gxhost.com.br." in that setup answers 404 for every single record,
   * and because DNS sync is best-effort by design it fails silently —
   * every server just keeps showing its plain ip:port with nothing but a
   * log line to say why.
   */
  private zone(): string {
    const zone = this.config.get<string>('PUBLIC_GATEWAY_DNS_ZONE') || this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    if (!zone) throw new ServiceUnavailableException('PUBLIC_GATEWAY_DNS_ZONE (or PUBLIC_GATEWAY_HOSTNAME_ZONE) is not configured');
    return zone;
  }

  /**
   * PowerDNS rejects an rrset outside the zone being patched, and the
   * whole PATCH — every rrset in it — fails as one. Checking here turns
   * that into a precise, actionable log line naming both the hostname and
   * the managed zone, instead of a bare "422 Unprocessable Entity" that
   * gives no hint which of the two settings is wrong.
   *
   * The case this really catches: a customer custom hostname, which
   * `deriveCustomHostname` composes directly under the APEX
   * ("survival.gxhost.com.br"). That name is outside a delegated
   * "mc.gxhost.com.br" zone, so PowerDNS genuinely cannot publish it —
   * the apex's own DNS host still owns those names.
   */
  private assertInZone(hostname: string): void {
    if (this.canPublish(hostname)) return;
    throw new ServiceUnavailableException(`"${hostname}" is outside the PowerDNS-managed zone "${this.zone()}" — it cannot be published there`);
  }

  /**
   * The same containment rule as `assertInZone`, as a question instead
   * of an exception, so a save can refuse a hostname up front rather
   * than accepting it and failing forever in the reconciler. Also
   * answers false when the zone is not configured at all — there is no
   * zone to be inside of.
   */
  canPublish(hostname: string): boolean {
    let zone: string;
    try {
      zone = this.fqdn(this.zone()).toLowerCase();
    } catch {
      return false;
    }
    const name = this.fqdn(hostname).toLowerCase();
    return name === zone || name.endsWith(`.${zone}`);
  }

  /** PowerDNS's own convention: every zone/record name is FQDN-absolute, always ending in a dot. */
  private fqdn(name: string): string {
    return name.endsWith('.') ? name : `${name}.`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey() };
  }

  private async patchRrsets(rrsets: Record<string, unknown>[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiUrl()}/api/v1/servers/${this.serverId()}/zones/${encodeURIComponent(this.fqdn(this.zone()))}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ rrsets }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new ServiceUnavailableException(`PowerDNS API PATCH zone failed (${res.status}): ${text}`);
      }
      this.zoneSnapshot = null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The zone as last seen, reused for at most ZONE_SNAPSHOT_TTL_MS. Only
   * ever consulted to decide whether a write can be skipped — never to
   * answer a question whose wrong answer would be visible to a customer
   * (isHostnameAvailable deliberately still reads fresh).
   */
  private zoneSnapshot: { at: number; zone: PowerDnsZone } | null = null;

  private async snapshotZone(): Promise<PowerDnsZone> {
    const now = Date.now();
    if (this.zoneSnapshot && now - this.zoneSnapshot.at < ZONE_SNAPSHOT_TTL_MS) return this.zoneSnapshot.zone;
    const zone = await this.getZone();
    this.zoneSnapshot = { at: now, zone };
    return zone;
  }

  /**
   * Whether the zone already holds exactly this rrset, so the REPLACE
   * would be a no-op.
   *
   * This exists because "no-op" is not free here. PowerDNS applies
   * SOA-EDIT-API to every PATCH, changed content or not, so each
   * pointless write bumps the zone's serial — and a bumped serial is
   * what makes a primary notify its secondaries. Found live right after
   * ns2 came up: GatewayService re-ensures every route's A and SRV on
   * each 30s reconcile pass even when nothing changed, which with seven
   * routes moved the serial 14 every 30 seconds and had ns2 pulling a
   * full AXFR of identical data roughly every 75 seconds, ~2900 times a
   * day. Nothing was broken by it, which is exactly why it went
   * unnoticed while there was no secondary and nobody reading serials.
   *
   * Errs toward writing: if the zone cannot be read, or anything about
   * the comparison is uncertain, this answers false and the PATCH goes
   * ahead. A redundant write costs a serial bump; a wrongly skipped one
   * would leave a customer's server unresolvable, so the two are not
   * remotely equal and the tie never goes to skipping.
   */
  private async rrsetIsCurrent(name: string, type: string, ttl: number, contents: string[]): Promise<boolean> {
    let zone: PowerDnsZone;
    try {
      zone = await this.snapshotZone();
    } catch (err) {
      this.logger.warn(`could not read zone to compare ${type} ${name}, writing anyway: ${(err as Error).message}`);
      return false;
    }

    const existing = zone.rrsets.find((r) => r.name === name && r.type === type);
    if (!existing || existing.ttl !== ttl) return false;

    // disabled records answer nothing, so they are not part of what
    // "already correct" means.
    const have = (existing.records ?? []).filter((r) => !r.disabled).map((r) => r.content).sort();
    const want = [...contents].sort();
    return have.length === want.length && have.every((c, i) => c === want[i]);
  }

  private async getZone(): Promise<PowerDnsZone> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiUrl()}/api/v1/servers/${this.serverId()}/zones/${encodeURIComponent(this.fqdn(this.zone()))}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new ServiceUnavailableException(`PowerDNS API GET zone failed (${res.status}): ${text}`);
      }
      return (await res.json()) as PowerDnsZone;
    } finally {
      clearTimeout(timeout);
    }
  }

  private srvName(hostname: string): string {
    return `_minecraft._tcp.${hostname}`;
  }

  async ensureSrv(input: SrvRecordInput): Promise<void> {
    this.assertInZone(this.srvName(input.hostname));
    const content = `0 0 ${input.port} ${this.fqdn(input.target)}`;
    if (await this.rrsetIsCurrent(this.fqdn(this.srvName(input.hostname)), 'SRV', 60, [content])) {
      this.logger.debug(`SRV record already current for ${input.hostname}, not rewriting`);
      return;
    }
    await this.patchRrsets([
      {
        name: this.fqdn(this.srvName(input.hostname)),
        type: 'SRV',
        changetype: 'REPLACE',
        ttl: 60,
        // "priority weight port target." — RFC 2782's own SRV content
        // format; priority/weight are meaningless with exactly one
        // target, so both are fixed at 0, same as CloudflareDnsProvider
        // already chose.
        records: [{ content, disabled: false }],
      },
    ]);
    this.logger.log(`SRV record ensured for ${input.hostname} -> ${input.target}:${input.port}`);
  }

  async removeSrv(hostname: string): Promise<void> {
    this.assertInZone(this.srvName(hostname));
    await this.patchRrsets([{ name: this.fqdn(this.srvName(hostname)), type: 'SRV', changetype: 'DELETE' }]);
    this.logger.log(`SRV record removed for ${hostname}`);
  }

  /**
   * Custom-hostname plan — the A/AAAA record for a hostname itself, same
   * role as CloudflareDnsProvider's own method. Type is picked from what
   * `ip` actually looks like; if it's neither (an operator configured
   * `Gateway.publicHost` as a hostname instead of a literal IP), this is
   * a documented limitation shared with the Cloudflare implementation it
   * replaces: log and return without calling the API.
   */
  async ensureAddressRecord(input: AddressRecordInput): Promise<void> {
    this.assertInZone(input.hostname);
    const type = isIPv4(input.ip) ? 'A' : isIPv6(input.ip) ? 'AAAA' : null;
    if (!type) {
      this.logger.warn(`ensureAddressRecord skipped for ${input.hostname}: "${input.ip}" is not a literal IPv4/IPv6 address`);
      return;
    }
    if (await this.rrsetIsCurrent(this.fqdn(input.hostname), type, 60, [input.ip])) {
      this.logger.debug(`${type} record already current for ${input.hostname}, not rewriting`);
      return;
    }
    await this.patchRrsets([
      { name: this.fqdn(input.hostname), type, changetype: 'REPLACE', ttl: 60, records: [{ content: input.ip, disabled: false }] },
    ]);
    this.logger.log(`${type} record ensured for ${input.hostname} -> ${input.ip}`);
  }

  async removeAddressRecord(hostname: string): Promise<void> {
    this.assertInZone(hostname);
    // Both types in ONE call, unconditionally — a DELETE changetype on an
    // rrset that was never there is a documented PowerDNS no-op, so
    // there's no need to check which type exists first the way
    // CloudflareDnsProvider's own findRecord dance had to.
    await this.patchRrsets([
      { name: this.fqdn(hostname), type: 'A', changetype: 'DELETE' },
      { name: this.fqdn(hostname), type: 'AAAA', changetype: 'DELETE' },
    ]);
    this.logger.log(`Address record removed for ${hostname}`);
  }

  /**
   * Live conflict check on top of the static reserved-word list
   * (hostname-policy.ts) — fetches the whole zone and looks for this
   * exact name under ANY record type, same "any existing record counts
   * as unavailable" rule CloudflareDnsProvider already used. Deliberately
   * the one method that never throws: a PowerDNS outage here must never
   * block a customer from saving a hostname, so any error resolves
   * `true` (fail open) rather than propagating.
   */
  async isHostnameAvailable(hostname: string): Promise<boolean> {
    try {
      const zone = await this.getZone();
      const target = this.fqdn(hostname);
      const exists = zone.rrsets.some((r) => r.name === target && (r.records?.length ?? 0) > 0);
      return !exists;
    } catch (err) {
      this.logger.warn(`isHostnameAvailable failed for ${hostname}, failing open: ${(err as Error).message}`);
      return true;
    }
  }
}
