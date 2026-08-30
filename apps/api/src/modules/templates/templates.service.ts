import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  CreateServerTemplateDto,
  CreateTemplateGroupDto,
  TemplateVariableDto,
  UpdateServerTemplateDto,
} from './dto/template.dto';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

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

    return this.prisma.serverTemplate.create({
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
        variables: dto.variables
          ? { create: dto.variables.map((v, i) => toVariableCreateInput(v, i)) }
          : undefined,
      },
      include: { variables: true },
    });
  }

  async updateTemplate(id: string, dto: UpdateServerTemplateDto) {
    await this.getTemplate(id);
    return this.prisma.serverTemplate.update({
      where: { id },
      data: { ...dto, dockerImages: dto.dockerImages as object | undefined },
    });
  }

  async removeTemplate(id: string) {
    await this.getTemplate(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { templateId: id } }));
    if (serverCount > 0) throw new ConflictException('Template is in use by existing servers');
    await this.prisma.serverTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async addVariable(templateId: string, dto: TemplateVariableDto) {
    await this.getTemplate(templateId);
    validateDeclaredVariables([dto]);
    const count = await this.prisma.templateVariable.count({ where: { templateId } });
    return this.prisma.templateVariable.create({ data: { templateId, ...toVariableCreateInput(dto, count) } });
  }

  async removeVariable(templateId: string, variableId: bigint) {
    const variable = await this.prisma.templateVariable.findFirst({ where: { id: variableId, templateId } });
    if (!variable) throw new NotFoundException('Variable not found');
    await this.prisma.templateVariable.delete({ where: { id: variableId } });
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
