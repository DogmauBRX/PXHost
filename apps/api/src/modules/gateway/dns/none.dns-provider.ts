import { Injectable } from '@nestjs/common';
import type { AddressRecordInput, DnsProvider, SrvRecordInput } from './dns-provider.interface';

/**
 * Default `DnsProvider` — never touches DNS, matching §16's "não altere
 * DNS automaticamente em produção sem deixar isso claramente
 * configurável." Bound whenever `PUBLIC_GATEWAY_DNS_PROVIDER` is unset
 * or anything other than `'powerdns'` (see `gateway.module.ts`'s
 * factory) — a customer's public address then falls back to
 * `gateway.publicHost:port` (public-address.ts), with no SRV record and
 * no wildcard hostname requirement at all.
 */
@Injectable()
export class NoneDnsProvider implements DnsProvider {
  async ensureSrv(_input: SrvRecordInput): Promise<void> {
    // Intentional no-op.
  }

  async removeSrv(_hostname: string): Promise<void> {
    // Intentional no-op.
  }

  async ensureAddressRecord(_input: AddressRecordInput): Promise<void> {
    // Intentional no-op.
  }

  async removeAddressRecord(_hostname: string): Promise<void> {
    // Intentional no-op.
  }

  /** No zone to check against when DNS automation is off — nothing can conflict with a record this provider never creates. */
  async isHostnameAvailable(_hostname: string): Promise<boolean> {
    return true;
  }

  /**
   * True, which reads oddly for a provider that publishes nothing, but
   * is the honest answer to what the caller asks: "will saving this
   * hand the customer an address that can never resolve?" With
   * automation off, nobody was promised a resolving hostname in the
   * first place — the address stays `host:port` and works. Returning
   * false here would block custom hostnames on every install that has
   * not configured DNS, which is the default one.
   */
  canPublish(_hostname: string): boolean {
    return true;
  }
}
