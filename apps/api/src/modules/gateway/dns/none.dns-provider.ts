import { Injectable } from '@nestjs/common';
import type { AddressRecordInput, DnsProvider, SrvRecordInput } from './dns-provider.interface';

/**
 * Default `DnsProvider` — never touches DNS, matching §16's "não altere
 * DNS automaticamente em produção sem deixar isso claramente
 * configurável." Bound whenever `PUBLIC_GATEWAY_DNS_PROVIDER` is unset
 * or anything other than `'cloudflare'` (see `gateway.module.ts`'s
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
}
