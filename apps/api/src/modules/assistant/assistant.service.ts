import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { PermissionCatalogService } from '../authorization/permission-catalog.service';
import { RedisService } from '../../core/redis/redis.service';
import { describeSoftware } from '../templates/software';
import { KnowledgeBaseProvider } from './kb/kb-provider';
import type { AssistantContext, AssistantMessage, AssistantProvider, AssistantReply, AssistantSuggestion } from './assistant.types';

const RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 10;

/**
 * The one place that turns "a logged-in user asking about server X" into
 * an AssistantContext and hands it to whichever AssistantProvider is
 * active — everything provider-agnostic (auth, rate limiting, context
 * assembly) lives here so the KB and a future LLM adapter share it
 * automatically instead of each re-implementing it.
 *
 * Deliberately does not depend on AgentClient or FilesService: this
 * service can look servers up and read their metadata, and that's all —
 * there is nothing here CAPABLE of starting a container, writing a file,
 * or running a console command, regardless of what any provider (KB or
 * LLM) decides to say.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly provider: AssistantProvider;

  constructor(
    private readonly access: ServerAccessService,
    private readonly permissionCatalog: PermissionCatalogService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly kb: KnowledgeBaseProvider,
  ) {
    const requested = this.config.get<string>('ASSISTANT_PROVIDER');
    if (requested === 'llm') {
      // No LLM adapter ships in this phase — AssistantProvider is the
      // documented seam for one, but until it exists (or ships without
      // ASSISTANT_LLM_API_KEY configured), falling back here beats
      // failing to boot or 500ing on every message.
      this.logger.warn('ASSISTANT_PROVIDER=llm requested but no LLM adapter is available — falling back to the knowledge base provider.');
    }
    this.provider = this.kb;
  }

  private async buildContext(actor: AccessActor, serverId: string): Promise<AssistantContext> {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    const allKeys = await this.permissionCatalog.keys();
    const permissions = allKeys.filter((key) => can(key));
    const primary = server.allocations.find((a) => a.isPrimary) ?? server.allocations[0] ?? null;

    return {
      serverName: server.name,
      memoryMb: server.memoryMb,
      diskMb: server.diskMb,
      status: server.status,
      powerState: server.powerState,
      software: describeSoftware(server.template?.softwareKind ?? null),
      plan: server.plan
        ? {
            name: server.plan.name,
            recommendedPlayersMin: server.plan.recommendedPlayersMin,
            recommendedPlayersMax: server.plan.recommendedPlayersMax,
            recommendedModsMin: server.plan.recommendedModsMin,
            recommendedModsMax: server.plan.recommendedModsMax,
            recommendedPluginsMin: server.plan.recommendedPluginsMin,
            recommendedPluginsMax: server.plan.recommendedPluginsMax,
          }
        : null,
      primaryAllocation: primary ? { ip: primary.ip, port: primary.port } : null,
      permissions,
    };
  }

  /** Fixed 60s window, INCR+EXPIRE — good enough for "stop a runaway client loop," not a precise sliding window. A future 'llm' provider gets its OWN, tighter daily bucket layered on top of this one (it costs money per message; the KB doesn't). */
  private async checkRateLimit(actorId: string): Promise<void> {
    const key = `assistant:rate:${actorId}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    if (count > RATE_LIMIT_PER_MINUTE) {
      throw new HttpException('Muitas mensagens em pouco tempo — aguarde um instante.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async chat(actor: AccessActor, serverId: string, message: string, history: AssistantMessage[]): Promise<AssistantReply> {
    await this.checkRateLimit(actor.id);
    const ctx = await this.buildContext(actor, serverId);
    return this.provider.reply(message.slice(0, MAX_MESSAGE_CHARS), history.slice(-MAX_HISTORY_TURNS), ctx);
  }

  async suggestions(actor: AccessActor, serverId: string): Promise<AssistantSuggestion[]> {
    const ctx = await this.buildContext(actor, serverId);
    return this.kb.suggestions(ctx);
  }
}
