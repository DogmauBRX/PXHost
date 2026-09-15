import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Gateway } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { DesiredRoute, GatewayDriver } from './gateway-driver.interface';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The only implementation of `GatewayDriver` today: talks to the small
 * control sidecar in `apps/gateway` over plain HTTP, bearer-token
 * authenticated (`PUBLIC_GATEWAY_TOKEN` — the SAME shared secret the
 * sidecar itself is configured with as `GATEWAY_TOKEN`; two env names
 * because they're two different processes/deployments, one value).
 *
 * Deliberately as thin as `AgentClient` is for the node agent: one HTTP
 * call, one timeout, one error shape. Never talks nginx, never touches a
 * config file — that's entirely `apps/gateway`'s job, reachable only
 * through this one PUT.
 */
@Injectable()
export class HttpGatewayDriver implements GatewayDriver {
  private readonly logger = new Logger(HttpGatewayDriver.name);

  constructor(private readonly config: ConfigService) {}

  async apply(gateway: Gateway, routes: DesiredRoute[]): Promise<void> {
    const token = this.config.get<string>('PUBLIC_GATEWAY_TOKEN');
    if (!token) {
      throw new ServiceUnavailableException('PUBLIC_GATEWAY_TOKEN is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${gateway.controlUrl.replace(/\/$/, '')}/api/routes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          routes: routes.map((r) => ({
            serverId: r.serverId,
            publicPort: r.publicPort,
            protocol: r.protocol,
            targetIp: r.targetIp,
            targetPort: r.targetPort,
          })),
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new ServiceUnavailableException(`Gateway ${gateway.name} returned ${res.status}: ${text.slice(0, 500)}`);
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`apply failed for gateway ${gateway.name}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(`Gateway request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
