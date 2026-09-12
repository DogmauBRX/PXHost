import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { SoftwareDiscoveryService } from './software-discovery.service';
import { PRESET_KINDS, type PresetKind } from './software-presets';
import {
  CreateServerTemplateDto,
  CreateTemplateFromPresetDto,
  CreateTemplateGroupDto,
  DuplicateTemplateDto,
  TemplateVariableDto,
  UpdateServerTemplateDto,
  UpdateTemplateVariableDto,
} from './dto/template.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

@Controller('api/admin')
@UseGuards(AdminGuard)
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly discovery: SoftwareDiscoveryService,
  ) {}

  // ---- criação rápida (wizard) ----

  @Post('templates/quick-create')
  createFromPreset(@Body() dto: CreateTemplateFromPresetDto) {
    return this.templates.createFromPreset(dto);
  }

  @Post('eggs/:id/duplicate')
  duplicateTemplate(@Param('id') id: string, @Body() dto: DuplicateTemplateDto) {
    return this.templates.duplicateTemplate(id, dto.name);
  }

  @Get('templates/discover/:kind/versions')
  discoverVersions(@Param('kind') kind: string) {
    return this.discovery.getVersions(assertPresetKind(kind));
  }

  @Get('templates/discover/:kind/versions/:mcVersion/builds')
  discoverBuilds(@Param('kind') kind: string, @Param('mcVersion') mcVersion: string) {
    return this.discovery.getBuilds(assertPresetKind(kind), mcVersion);
  }

  @Get('nests')
  listGroups() {
    return this.templates.listGroups();
  }

  @Post('nests')
  createGroup(@Body() dto: CreateTemplateGroupDto) {
    return this.templates.createGroup(dto);
  }

  @Get('eggs')
  listTemplates(@Query('groupId') groupId?: string) {
    return this.templates.listTemplates(groupId);
  }

  @Get('eggs/:id')
  getTemplate(@Param('id') id: string) {
    return this.templates.getTemplate(id);
  }

  @Post('eggs')
  createTemplate(@Body() dto: CreateServerTemplateDto) {
    return this.templates.createTemplate(dto);
  }

  @Patch('eggs/:id')
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateServerTemplateDto) {
    return this.templates.updateTemplate(id, dto);
  }

  @Delete('eggs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeTemplate(@Param('id') id: string) {
    return this.templates.removeTemplate(id);
  }

  @Post('eggs/:id/variables')
  addVariable(@Param('id') id: string, @Body() dto: TemplateVariableDto) {
    return this.templates.addVariable(id, dto);
  }

  @Patch('eggs/:id/variables/:variableId')
  updateVariable(@Param('id') id: string, @Param('variableId') variableId: string, @Body() dto: UpdateTemplateVariableDto) {
    return this.templates.updateVariable(id, parseBigIntParam(variableId), dto);
  }

  @Delete('eggs/:id/variables/:variableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeVariable(@Param('id') id: string, @Param('variableId') variableId: string) {
    return this.templates.removeVariable(id, parseBigIntParam(variableId));
  }
}

function parseBigIntParam(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new NotFoundException('Variable not found');
  }
}

function assertPresetKind(value: string): PresetKind {
  if ((PRESET_KINDS as readonly string[]).includes(value)) return value as PresetKind;
  throw new BadRequestException(`Unknown software preset: ${value}`);
}
