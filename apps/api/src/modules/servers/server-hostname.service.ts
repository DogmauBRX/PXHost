import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { GatewayService } from '../gateway/gateway.service';
import { isReservedHostnameLabel } from '../gateway/hostname-policy';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';

/**
 * Custom-hostname plan — the customer-facing "set my server's public
 * address" surface. Mirrors `server-variables.service.ts`'s shape
 * exactly (same `access.resolve` gate, same audit/activity pair) since
 * this is the same kind of thing: a customer-initiated server setting,
 * distinct from the fire-and-forget infra hooks `GatewayService`'s own
 * `ensureRouteForServer`/`markRemoving` are for `ServersService`.
 */
@Injectable()
export class ServerHostnameService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly gateway: GatewayService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async update(actor: AccessActor, serverId: string, hostname: string | null) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('hostname.update')) throw new ForbiddenException('Missing permission: hostname.update');

    // Format is already enforced by UpdateServerHostnameDto's decorators
    // — "reserved word" can't easily be expressed as a declarative
    // decorator, so it's checked here instead, same belt-and-suspenders
    // posture server-variables.service.ts already uses for editability.
    if (hostname !== null && isReservedHostnameLabel(hostname)) {
      throw new BadRequestException('Este endereço é reservado e não pode ser usado');
    }

    const route = await this.gateway.setCustomHostname(server.id, hostname);

    await this.audit.record({
      action: 'server.hostname.update',
      targetType: 'server',
      targetId: server.id,
      actorId: actor.id,
      metadata: { hostname, asAdmin: actor.isAdmin },
    });
    await this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.hostname.update', properties: { hostname } });

    return { customHostname: route.customHostname };
  }
}
