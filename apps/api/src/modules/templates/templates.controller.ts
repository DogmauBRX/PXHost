import {
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
import {
  CreateServerTemplateDto,
  CreateTemplateGroupDto,
  TemplateVariableDto,
  UpdateServerTemplateDto,
} from './dto/template.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

@Controller('api/admin')
@UseGuards(AdminGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

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
