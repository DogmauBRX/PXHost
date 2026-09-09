import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  CreateServerTemplateDto,
  CreateTemplateGroupDto,
  TemplateVariableDto,
  UpdateServerTemplateDto,
  UpdateTemplateVariableDto,
} from './dto/template.dto';
import { PublicTemplatesService } from '../public/public-templates.service';

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
        installImage: dto.installImage ?? 'ghcr.io/pxhost/installers:debian',
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
