import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DnsProvider, SrvRecordInput } from './dns-provider.interface';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
}

/**
 * Real SRV automation via Cloudflare's DNS API — bound only when an
 * admin explicitly sets `PUBLIC_GATEWAY_DNS_PROVIDER=cloudflare` (see
 * `gateway.module.ts`). `_minecraft._tcp.<hostname>` is the standard SRV
 * service name Minecraft's own client resolver looks up before falling
 * back to a plain `A`/`AAAA` + typed port, per the protocol's own SRV
 * convention — this is not a GXhost-specific choice.
 *
 * `ensureSrv` looks the record up by name first: Cloudflare's create
 * endpoint doesn't upsert, and a naive POST-every-time would pile up
 * duplicate SRV records for the same hostname on every reconcile tick.
 */
@Injectable()
export class CloudflareDnsProvider implements DnsProvider {
  private readonly logger = new Logger(CloudflareDnsProvider.name);

  constructor(private readonly config: ConfigService) {}

  private token(): string {
    const token = this.config.get<string>('PUBLIC_GATEWAY_DNS_API_TOKEN');
    if (!token) throw new ServiceUnavailableException('PUBLIC_GATEWAY_DNS_API_TOKEN is not configured');
    return token;
  }

  private zoneId(): string {
    const zoneId = this.config.get<string>('PUBLIC_GATEWAY_DNS_ZONE_ID');
    if (!zoneId) throw new ServiceUnavailableException('PUBLIC_GATEWAY_DNS_ZONE_ID is not configured');
    return zoneId;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token()}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = (await res.json()) as { success: boolean; result: T; errors?: unknown[] };
      if (!res.ok || !json.success) {
        throw new ServiceUnavailableException(`Cloudflare API ${method} ${path} failed: ${JSON.stringify(json.errors ?? res.statusText)}`);
      }
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private srvName(hostname: string): string {
    return `_minecraft._tcp.${hostname}`;
  }

  private async findRecord(name: string): Promise<CloudflareDnsRecord | null> {
    const records = await this.call<CloudflareDnsRecord[]>(
      'GET',
      `/zones/${this.zoneId()}/dns_records?type=SRV&name=${encodeURIComponent(name)}`,
    );
    return records[0] ?? null;
  }

  async ensureSrv(input: SrvRecordInput): Promise<void> {
    const name = this.srvName(input.hostname);
    const data = {
      type: 'SRV',
      name,
      data: {
        service: '_minecraft',
        proto: '_tcp',
        name: input.hostname,
        priority: 0,
        weight: 0,
        port: input.port,
        target: input.target,
      },
      ttl: 60,
    };

    const existing = await this.findRecord(name);
    if (existing) {
      await this.call('PATCH', `/zones/${this.zoneId()}/dns_records/${existing.id}`, data);
    } else {
      await this.call('POST', `/zones/${this.zoneId()}/dns_records`, data);
    }
    this.logger.log(`SRV record ensured for ${input.hostname} -> ${input.target}:${input.port}`);
  }

  async removeSrv(hostname: string): Promise<void> {
    const existing = await this.findRecord(this.srvName(hostname));
    if (!existing) return;
    await this.call('DELETE', `/zones/${this.zoneId()}/dns_records/${existing.id}`);
    this.logger.log(`SRV record removed for ${hostname}`);
  }
}
