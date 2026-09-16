import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { AgentClient } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import { deriveVariableOptionShape, validateVariableValue, type VariableOptionKind } from './variable-rules';

export interface ClientVariable {
  id: string;
  name: string;
  description: string | null;
  envVariable: string;
  value: string;
  defaultValue: string;
  rules: string;
  isEditable: boolean;
  // Derived from `rules` (deriveVariableOptionShape) — lets the panel
  // render a dropdown instead of free text whenever an admin has
  // curated a value list (`in:a,b,c`, e.g. via the "criação rápida"
  // wizard or TemplatesService.refreshMinecraftVersions), same shape the
  // pre-purchase checkout catalog already exposes for the same reason.
  kind: VariableOptionKind;
  choices?: string[];
  min?: number;
  max?: number;
}

@Injectable()
export class ServerVariablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ServerAccessService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  /** Only `isUserViewable` rows — the template may declare internal-only variables (e.g. reserved for the install script) the customer was never meant to see, let alone edit. */
  async list(actor: AccessActor, serverId: string): Promise<ClientVariable[]> {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('startup.read')) throw new ForbiddenException('Missing permission: startup.read');
    // 'setup_pending' has no template yet (see servers_setup_consistency) —
    // `startup.read` itself still passes ServerAccessService's gate (every
    // `.read` permission does, even pre-setup), so the setup screen's own
    // calls to this endpoint must see an empty list, never a crash.
    if (!server.templateId) return [];

    const [templateVars, serverVars] = await Promise.all([
      this.prisma.templateVariable.findMany({ where: { templateId: server.templateId, isUserViewable: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.serverVariable.findMany({ where: { serverId: server.id } }),
    ]);
    const valueByVariableId = new Map(serverVars.map((v) => [v.variableId.toString(), v.value]));

    return templateVars.map((tv) => ({
      id: tv.id.toString(),
      name: tv.name,
      description: tv.description,
      envVariable: tv.envVariable,
      value: valueByVariableId.get(tv.id.toString()) ?? tv.defaultValue,
      defaultValue: tv.defaultValue,
      rules: tv.rules,
      isEditable: tv.isUserEditable,
      ...deriveVariableOptionShape(tv.rules),
    }));
  }

  /**
   * `values` is a PARTIAL map, keyed by envVariable — only the fields the
   * customer's form actually changed. Every other declared variable keeps
   * its current stored value; this is what lets the panel send just the
   * edited field(s) without first re-reading and echoing back every
   * variable it didn't touch.
   *
   * Rejects (400) an unknown envVariable, a non-editable one, or a value
   * that fails its own `rules` string — never silently drops or clamps a
   * bad value. The actual container recreate only happens after every
   * check passes, and only if the agent agrees the server is stopped (see
   * AgentClient.updateVariables's doc comment) — a 409 from THAT check
   * surfaces to the caller as-is, since server-side truth about whether a
   * container is running is the agent's, never this DB row's stale
   * `powerState`.
   */
  async update(actor: AccessActor, serverId: string, values: Record<string, string>): Promise<ClientVariable[]> {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('startup.update')) throw new ForbiddenException('Missing permission: startup.update');
    // 'setup_pending' has no template yet — there is nothing to edit here
    // until ServerSetupService.complete picks one. In practice
    // ServerAccessService already blocks 'startup.update' for this
    // status (Fase 7), so this is a second, explicit guard rather than
    // the only one — belt and suspenders for a TypeScript-visible null.
    if (!server.templateId) throw new ConflictException('Server has no template yet — complete initial setup first');

    const [templateVars, serverVars] = await Promise.all([
      this.prisma.templateVariable.findMany({ where: { templateId: server.templateId } }),
      this.prisma.serverVariable.findMany({ where: { serverId: server.id } }),
    ]);
    const byEnvVar = new Map(templateVars.map((tv) => [tv.envVariable, tv]));
    const currentByVariableId = new Map(serverVars.map((v) => [v.variableId.toString(), v.value]));

    for (const [key, value] of Object.entries(values)) {
      const tv = byEnvVar.get(key);
      if (!tv) throw new BadRequestException(`Variável desconhecida: ${key}`);
      if (!tv.isUserEditable) throw new ForbiddenException(`Variável não editável: ${key}`);
      const error = validateVariableValue(value, tv.rules);
      if (error) throw new BadRequestException(`${tv.name}: ${error}`);
    }

    const resolvedValues: Record<string, string> = {};
    for (const tv of templateVars) {
      resolvedValues[tv.envVariable] = values[tv.envVariable] ?? currentByVariableId.get(tv.id.toString()) ?? tv.defaultValue;
    }

    await this.agent.updateVariables(
      server.nodeId,
      server.id,
      templateVars.map((tv) => tv.envVariable),
      resolvedValues,
    );

    await this.prisma.$transaction(
      templateVars
        .filter((tv) => values[tv.envVariable] !== undefined)
        .map((tv) =>
          this.prisma.serverVariable.upsert({
            where: { serverId_variableId: { serverId: server.id, variableId: tv.id } },
            update: { value: resolvedValues[tv.envVariable] },
            create: { serverId: server.id, variableId: tv.id, value: resolvedValues[tv.envVariable] },
          }),
        ),
    );

    await this.audit.record({
      action: 'server.variables.update',
      targetType: 'server',
      targetId: server.id,
      actorId: actor.id,
      metadata: { changed: Object.keys(values), asAdmin: actor.isAdmin },
    });
    await this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.variables.update', properties: { changed: Object.keys(values) } });

    return this.list(actor, serverId);
  }
}
