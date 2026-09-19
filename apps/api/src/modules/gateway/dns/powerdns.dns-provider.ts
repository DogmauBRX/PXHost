import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIPv4, isIPv6 } from 'node:net';
import type { AddressRecordInput, DnsProvider, SrvRecordInput } from './dns-provider.interface';

const REQUEST_TIMEOUT_MS = 10_000;

interface PowerDnsRRSet {
  name: string;
  type: string;
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

  // The SAME zone `deriveHostname`/`deriveCustomHostname` (public-address.ts)
  // already compose hostnames under — PowerDNS has no separate "zone ID"
  // concept the way Cloudflare does, so this one existing var covers both
  // "what zone do I compose a hostname under" and "what zone does the API
  // manage," with nothing new to configure.
  private zone(): string {
    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    if (!zone) throw new ServiceUnavailableException('PUBLIC_GATEWAY_HOSTNAME_ZONE is not configured');
    return zone;
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
    } finally {
      clearTimeout(timeout);
    }
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
        records: [{ content: `0 0 ${input.port} ${this.fqdn(input.target)}`, disabled: false }],
      },
    ]);
    this.logger.log(`SRV record ensured for ${input.hostname} -> ${input.target}:${input.port}`);
  }

  async removeSrv(hostname: string): Promise<void> {
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
    const type = isIPv4(input.ip) ? 'A' : isIPv6(input.ip) ? 'AAAA' : null;
    if (!type) {
      this.logger.warn(`ensureAddressRecord skipped for ${input.hostname}: "${input.ip}" is not a literal IPv4/IPv6 address`);
      return;
    }
    await this.patchRrsets([
      { name: this.fqdn(input.hostname), type, changetype: 'REPLACE', ttl: 60, records: [{ content: input.ip, disabled: false }] },
    ]);
    this.logger.log(`${type} record ensured for ${input.hostname} -> ${input.ip}`);
  }

  async removeAddressRecord(hostname: string): Promise<void> {
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
