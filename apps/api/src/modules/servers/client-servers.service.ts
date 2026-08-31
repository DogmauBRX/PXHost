import { ForbiddenException, Injectable } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { AgentClient } from '../nodes/agent-client.service';
import { CapabilityTokenService } from '../../core/capability-token/capability-token.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';

const CONSOLE_TOKEN_TTL_SECONDS = 300;

// The full set of permissions the agent's WS protocol understands
// (architecture doc 4.5/5.2) — an owner's token carries every one of
// them; a subuser's token carries only whatever ServerAccessService.can
// actually grants (architecture doc 2.5), so the agent's OWN WS-side
// permission check — the one enforcement point the panel API doesn't
// mediate at all, since the browser talks to the agent directly after
// the token is minted — sees the real, resolved set either way.
const WS_PERMISSION_KEYS = ['websocket.connect', 'control.console', 'control.start', 'control.stop', 'control.restart', 'control.kill'];

const POWER_PERMISSION: Record<'start' | 'stop' | 'restart' | 'kill', string> = {
  start: 'control.start',
  stop: 'control.stop',
  restart: 'control.restart',
  kill: 'control.kill',
};

@Injectable()
export class ClientServersService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly agent: AgentClient,
    private readonly capabilityTokens: CapabilityTokenService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  list(userId: string) {
    return this.access.listAccessible(userId);
  }

  async get(actor: AccessActor, serverId: string) {
    const { server } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    return server;
  }

  async power(actor: AccessActor, serverId: string, action: 'start' | 'stop' | 'restart' | 'kill') {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can(POWER_PERMISSION[action])) throw new ForbiddenException(`Missing permission: ${POWER_PERMISSION[action]}`);

    const result = await this.agent.power(server.nodeId, server.id, action);
    await this.audit.record({
      action: `server.power.${action}`,
      targetType: 'server',
      targetId: server.id,
      actorId: actor.id,
      metadata: { previous: result.previous, state: result.state, asAdmin: actor.isAdmin },
    });
    await this.activity.record({ actorId: actor.id, serverId: server.id, event: `server.power.${action}`, properties: { previous: result.previous, state: result.state } });
    return result;
  }

  /**
   * Mints the capability token `useServerSocket` sends as the WS
   * connection's first `auth` frame (architecture doc 5.2). Re-fetching
   * ownership on every mint — rather than trusting a token minted minutes
   * ago — is what lets a revoked/transferred server stop handing out new
   * tokens immediately, without needing to touch the agent at all. The
   * `permissions` list embedded in the token is the ONLY place a
   * subuser's actual grants reach the agent, since the browser talks to
   * it directly after this — an owner's token normally carries every WS
   * permission key, a subuser's carries only what was actually granted.
   * Both are still subject to `can()`'s status gate (architecture doc
   * roadmap M14): a SUSPENDED server's token comes back with none of the
   * `control` group at all, owner included — `websocket.connect` itself
   * is in that group, so a suspended server's console token can't even
   * open the socket; the agent's own `Suspended()` check
   * (ws.go) is the second, independent enforcement of the same rule.
   *
   * An admin's token is unaffected by suspension (`can()` returns true
   * unconditionally for role 'admin') — inspecting/reviving a suspended
   * server's console is an operator action, not a customer one.
   */
  async mintConsoleToken(actor: AccessActor, serverId: string) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    const permissions = WS_PERMISSION_KEYS.filter((key) => can(key));
    const token = this.capabilityTokens.mint({
      serverUuid: server.id,
      nodeUuid: server.nodeId,
      userId: actor.id,
      cap: 'ws',
      permissions,
      ttlSeconds: CONSOLE_TOKEN_TTL_SECONDS,
    });
    const wsUrl = this.agent.wsUrl(server.node.scheme, server.node.fqdn, server.node.daemonPort, server.id);
    return { token, expiresIn: CONSOLE_TOKEN_TTL_SECONDS, wsUrl };
  }
}
