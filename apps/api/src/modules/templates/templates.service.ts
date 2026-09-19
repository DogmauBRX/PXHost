import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  CreateServerTemplateDto,
  CreateTemplateFromPresetDto,
  CreateTemplateGroupDto,
  TemplateVariableDto,
  UpdateServerTemplateDto,
  UpdateTemplateVariableDto,
} from './dto/template.dto';
import { PublicTemplatesService } from '../public/public-templates.service';
import { SoftwareDiscoveryService } from './software-discovery.service';
import { KNOWN_MINECRAFT_VERSIONS, SOFTWARE_PRESETS, type PresetKind } from './software-presets';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    // Same reasoning as PlansService -> PublicPlansService: the public
    // checkout catalog is 60s-cached (public-templates.service.ts), so any
    // admin write that could change what a customer sees — publishing,
    // unpublishing, deactivating, or editing a customer-facing variable —
    // invalidates it rather than making customers wait out the TTL.
    private readonly publicTemplates: PublicTemplatesService,
    private readonly discovery: SoftwareDiscoveryService,
  ) {}

  // ---- groups ("nests") ----

  listGroups() {
    return this.prisma.templateGroup.findMany({
      where: { deletedAt: null },
      include: { _count: { select: { templates: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createGroup(dto: CreateTemplateGroupDto) {
    const existing = await this.prisma.templateGroup.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' }, deletedAt: null },
    });
    if (existing) throw new ConflictException('A group with this name already exists');
    return this.prisma.templateGroup.create({ data: dto });
  }

  // ---- templates ("eggs") ----

  listTemplates(groupId?: string) {
    return this.prisma.serverTemplate.findMany({
      where: { deletedAt: null, ...(groupId ? { groupId } : {}) },
      include: { group: true, variables: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  async getTemplate(id: string) {
    const template = await this.prisma.serverTemplate.findFirst({
      where: { id, deletedAt: null },
      include: { group: true, variables: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async createTemplate(dto: CreateServerTemplateDto) {
    const group = await this.prisma.templateGroup.findFirst({ where: { id: dto.groupId, deletedAt: null } });
    if (!group) throw new NotFoundException('Template group not found');

    validateDeclaredVariables(dto.variables ?? []);

    const created = await this.prisma.serverTemplate.create({
      data: {
        groupId: dto.groupId,
        name: dto.name,
        author: dto.author,
        description: dto.description,
        dockerImages: dto.dockerImages as object,
        startupCommand: dto.startupCommand,
        stopCommand: dto.stopCommand ?? 'stop',
        installImage: dto.installImage ?? 'ghcr.io/parkervcp/installers:debian',
        installEntrypoint: dto.installEntrypoint ?? 'bash',
        installScript: dto.installScript,
        softwareKind: dto.softwareKind,
        isPublic: dto.isPublic ?? false,
        sortOrder: dto.sortOrder ?? 0,
        iconUrl: dto.iconUrl,
        variables: dto.variables
          ? { create: dto.variables.map((v, i) => toVariableCreateInput(v, i)) }
          : undefined,
      },
      include: { variables: true },
    });
    await this.publicTemplates.invalidateCache();
    return created;
  }

  /**
   * The "criação rápida" wizard's entry point (Admin Templates redesign):
   * expands the chosen preset (`software-presets.ts` — the exact same
   * docker image/startup command/install script `prisma/seed.ts` seeds)
   * plus the admin's curated version/build lists into a full
   * `CreateServerTemplateDto`, then delegates to `createTemplate` —
   * every check that method already does (group exists, envVariable
   * shape, cache invalidation) applies here unchanged, so this is purely
   * a friendlier front door, never a second code path.
   *
   * The `MINECRAFT_VERSION` (and build/loader, when the preset has one)
   * variable's `rules` gets its free-text `required|string|max:N`
   * replaced with `...|in:<list>` — the exact mechanism
   * `PublicTemplatesService.deriveOptionShape` already reads to build the
   * client setup screen's version dropdown, and `resolveDeclaredVariables`
   * already enforces at setup time. No new validation path, just this
   * one rule string assembled from chips instead of typed by hand.
   */
  async createFromPreset(dto: CreateTemplateFromPresetDto) {
    const preset = SOFTWARE_PRESETS[dto.softwareKind];

    if (preset.buildVariable && (!dto.builds || dto.builds.length === 0)) {
      throw new BadRequestException(`${preset.name} requires at least one build/loader version`);
    }

    const variables = preset.variables.map((v) => {
      if (v.envVariable === preset.versionVariable) {
        // The preset's own `defaultValue` is the "latest" sentinel (see
        // software-presets.ts) — meaningful only while `rules` is still
        // free text. Once curated to `in:<list>`, "latest" stops being a
        // legal value, so the default must become a real member of that
        // same list — the client setup screen (`getSetupInfo`) trusts
        // this column verbatim as the pre-selected version.
        return { ...v, rules: withInList(v.rules, dto.minecraftVersions), defaultValue: dto.minecraftVersions[0] };
      }
      if (preset.buildVariable && v.envVariable === preset.buildVariable) {
        return { ...v, rules: withInList(v.rules, dto.builds!), defaultValue: dto.builds![0] };
      }
      return v;
    });

    const created = await this.createTemplate({
      groupId: dto.groupId,
      name: dto.name,
      author: 'gxhost',
      description: dto.description ?? preset.description,
      dockerImages: preset.dockerImages,
      startupCommand: preset.startupCommand,
      stopCommand: preset.stopCommand,
      installImage: preset.installImage,
      installEntrypoint: preset.installEntrypoint,
      installScript: preset.installScript,
      softwareKind: preset.softwareKind,
      variables,
      isPublic: dto.isPublic ?? true,
      sortOrder: 0,
    });

    // `CreateServerTemplateDto` has no `isActive` field at all — the
    // schema default (true) already matches the wizard's own default
    // toggle state, so this only ever does a second write for the
    // deliberate "criar já desativado" case.
    if (dto.isActive === false) return this.updateTemplate(created.id, { isActive: false });
    return created;
  }

  /**
   * Clones an existing template — the wizard's "Duplicar" action (e.g.
   * bootstrap a new Purpur template from an already-configured Paper one).
   * `isPublic: false` on purpose: a copy never goes live in front of
   * customers before the admin has actually looked at it and, at minimum,
   * renamed it — the exact opposite default `createTemplate`'s own DTO
   * uses, deliberately, since duplicating is never itself a publish
   * action. `isActive: true` — nothing about a duplicate should be
   * unusable by default, only invisible to customers until opted in.
   */
  async duplicateTemplate(id: string, newName: string) {
    const source = await this.getTemplate(id);
    return this.createTemplate({
      groupId: source.groupId,
      name: newName,
      author: source.author,
      description: source.description ?? undefined,
      dockerImages: source.dockerImages as Record<string, string>,
      startupCommand: source.startupCommand,
      stopCommand: source.stopCommand,
      installImage: source.installImage,
      installEntrypoint: source.installEntrypoint,
      installScript: source.installScript,
      // Cast, not re-validated: the source row already passed
      // `validateDeclaredVariables`-equivalent checks (`IsIn(SOFTWARE_KINDS)`
      // on write) when it was first created — duplicating it can never
      // introduce a kind that wasn't already valid.
      softwareKind: (source.softwareKind ?? undefined) as CreateServerTemplateDto['softwareKind'],
      isPublic: false,
      sortOrder: source.sortOrder,
      iconUrl: source.iconUrl ?? undefined,
      variables: source.variables.map((v) => ({
        name: v.name,
        description: v.description ?? undefined,
        envVariable: v.envVariable,
        defaultValue: v.defaultValue,
        rules: v.rules,
        isUserViewable: v.isUserViewable,
        isUserEditable: v.isUserEditable,
        sortOrder: v.sortOrder,
      })),
    });
  }

  async updateTemplate(id: string, dto: UpdateServerTemplateDto) {
    await this.getTemplate(id);
    const updated = await this.prisma.serverTemplate.update({
      where: { id },
      data: { ...dto, dockerImages: dto.dockerImages as object | undefined },
    });
    await this.publicTemplates.invalidateCache();
    return updated;
  }

  async removeTemplate(id: string) {
    await this.getTemplate(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { templateId: id } }));
    if (serverCount > 0) throw new ConflictException('Template is in use by existing servers');
    await this.prisma.serverTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.publicTemplates.invalidateCache();
  }

  async addVariable(templateId: string, dto: TemplateVariableDto) {
    await this.getTemplate(templateId);
    validateDeclaredVariables([dto]);
    const count = await this.prisma.templateVariable.count({ where: { templateId } });
    const created = await this.prisma.templateVariable.create({ data: { templateId, ...toVariableCreateInput(dto, count) } });
    await this.publicTemplates.invalidateCache();
    return created;
  }

  async removeVariable(templateId: string, variableId: bigint) {
    const variable = await this.prisma.templateVariable.findFirst({ where: { id: variableId, templateId } });
    if (!variable) throw new NotFoundException('Variable not found');
    await this.prisma.templateVariable.delete({ where: { id: variableId } });
    await this.publicTemplates.invalidateCache();
  }

  /**
   * Add/remove already existed; this fills the gap that made `rules` a
   * write-once field in practice (the panel's variable form only ever
   * created rows with the service default `'nullable|string'`, with no way
   * to tighten them afterward). `envVariable` is deliberately not
   * editable here — it's the join key the agent's env allowlist and every
   * existing `ServerVariable` row are keyed on; changing it is a
   * remove+add, not an update.
   */
  async updateVariable(templateId: string, variableId: bigint, dto: UpdateTemplateVariableDto) {
    const variable = await this.prisma.templateVariable.findFirst({ where: { id: variableId, templateId } });
    if (!variable) throw new NotFoundException('Variable not found');
    const updated = await this.prisma.templateVariable.update({
      where: { id: variableId },
      data: {
        name: dto.name,
        description: dto.description,
        defaultValue: dto.defaultValue,
        rules: dto.rules,
        isUserViewable: dto.isUserViewable,
        isUserEditable: dto.isUserEditable,
        sortOrder: dto.sortOrder,
      },
    });
    await this.publicTemplates.invalidateCache();
    return updated;
  }

  /**
   * Curates an EXISTING template's version variable with a fresh live
   * list, the same `in:<list>` mechanism `createFromPreset`'s
   * `withInList` writes at creation time — but usable any time after,
   * for templates that were seeded/created before ever being curated
   * (every `prisma/seed.ts`-seeded default template, in practice: their
   * `MINECRAFT_VERSION` rules ship as plain `required|string|max:16`,
   * so the Configurações tab shows free text instead of a dropdown until
   * this runs at least once). Only the top-level Minecraft-version field
   * is refreshed here — the build/loader field (Paper Build, Fabric
   * Loader Version, etc.) is deliberately left alone, since a real value
   * list for it depends on WHICH Minecraft version is picked
   * (`SoftwareDiscoveryService.getBuilds` takes an `mcVersion` argument),
   * which doesn't fit a single "refresh" action the way the wizard's own
   * two-step version-then-build flow does.
   */
  async refreshMinecraftVersions(templateId: string) {
    const template = await this.getTemplate(templateId);
    if (!template.softwareKind || !(template.softwareKind in SOFTWARE_PRESETS)) {
      throw new ConflictException('Este template não declara um softwareKind reconhecido — não há de onde descobrir versões automaticamente');
    }
    const softwareKind = template.softwareKind as PresetKind;

    // Live first (freshest — catches a release this hardcoded list
    // hasn't been updated for yet); KNOWN_MINECRAFT_VERSIONS only as a
    // fallback, never the other way around. Found live: this used to
    // just throw here, meaning a third-party outage left the admin with
    // no way to curate a template at all, not even to the same
    // known-good baseline `getSetupInfo` itself now falls back to.
    const liveVersions = await this.discovery.getVersions(softwareKind);
    const versions = liveVersions.length > 0 ? liveVersions : KNOWN_MINECRAFT_VERSIONS[softwareKind];

    const versionVariable = SOFTWARE_PRESETS[softwareKind].versionVariable;
    const variable = template.variables.find((v) => v.envVariable === versionVariable);
    if (!variable) {
      throw new NotFoundException(`Este template não tem uma variável ${versionVariable} para curar`);
    }

    const updated = await this.prisma.templateVariable.update({
      where: { id: variable.id },
      data: {
        rules: withInList(variable.rules, versions),
        // Keep the current default if it's still a real option; only
        // fall back to the newest fetched version if it isn't (e.g. the
        // very first curation of a template whose default was the
        // free-text "latest" sentinel, which stops being valid the
        // moment `rules` gains an `in:` list).
        defaultValue: versions.includes(variable.defaultValue) ? variable.defaultValue : versions[0],
      },
    });
    await this.publicTemplates.invalidateCache();
    return updated;
  }
}

// Matches the agent's own env key regex (internal/spec/env.go:
// `^[A-Z][A-Z0-9_]{0,63}$`) so an admin cannot save a template whose
// variables would be silently dropped by BuildEnv's allowlist the moment
// a server actually starts.
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function validateDeclaredVariables(vars: TemplateVariableDto[]): void {
  for (const v of vars) {
    if (!ENV_VAR_RE.test(v.envVariable)) {
      throw new ConflictException(
        `Invalid envVariable "${v.envVariable}": must match ${ENV_VAR_RE} to be usable by the agent`,
      );
    }
  }
}

function toVariableCreateInput(v: TemplateVariableDto, sortOrder: number) {
  return {
    name: v.name,
    description: v.description,
    envVariable: v.envVariable,
    defaultValue: v.defaultValue ?? '',
    rules: v.rules ?? 'nullable|string',
    isUserViewable: v.isUserViewable ?? true,
    isUserEditable: v.isUserEditable ?? true,
    sortOrder: v.sortOrder ?? sortOrder,
  };
}

/**
 * Replaces a rules string's value list with `in:<curated list>` — appended
 * (not merged with any pre-existing `in:` token, since a preset's own
 * default rules never declare one) so `required|string|max:16` becomes
 * `required|string|max:16|in:1.21.4,1.21.1`. `variable-rules.ts`'s
 * `in:` validator and `deriveOptionShape`'s `in:` -> `choices[]` reader
 * both already handle this exact shape — this is the one place that
 * WRITES it, from the wizard's chips instead of an admin typing it.
 */
export function withInList(baseRules: string | undefined, values: string[]): string {
  const rules = (baseRules ?? 'required|string').replace(/\|?in:[^|]*/, '');
  return `${rules}|in:${values.join(',')}`;
}
