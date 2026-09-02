import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { SOFTWARE_KINDS, type SoftwareKind } from '../software';

export class CreateTemplateGroupDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class TemplateVariableDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @Length(1, 255)
  envVariable!: string;

  @IsOptional()
  @IsString()
  defaultValue?: string;

  @IsOptional()
  @IsString()
  rules?: string;

  @IsOptional()
  @IsBoolean()
  isUserViewable?: boolean;

  @IsOptional()
  @IsBoolean()
  isUserEditable?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class CreateServerTemplateDto {
  @IsString()
  groupId!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsString()
  @Length(1, 191)
  author!: string;

  @IsOptional()
  @IsString()
  description?: string;

  // { "<label>": "<image ref, ideally digest-pinned>" }, matching what
  // the Go agent's spec.BuildContainerSpec ultimately consumes
  // (architecture doc 4.3).
  @IsObject()
  dockerImages!: Record<string, string>;

  @IsString()
  startupCommand!: string;

  @IsOptional()
  @IsString()
  stopCommand?: string;

  @IsOptional()
  @IsString()
  installImage?: string;

  @IsOptional()
  @IsString()
  installEntrypoint?: string;

  @IsString()
  installScript!: string;

  // Drives which addon directory (/plugins vs /mods) the client-facing
  // Add-ons page and the assistant point the customer at — see
  // modules/templates/software.ts. Optional: an admin can classify a
  // template later from the Templates page.
  @IsOptional()
  @IsIn(SOFTWARE_KINDS)
  softwareKind?: SoftwareKind;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];
}

export class UpdateServerTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  author?: string;

  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  dockerImages?: Record<string, string>;

  @IsOptional()
  @IsString()
  startupCommand?: string;

  @IsOptional()
  @IsString()
  stopCommand?: string;

  @IsOptional()
  @IsString()
  installImage?: string;

  @IsOptional()
  @IsString()
  installEntrypoint?: string;

  @IsOptional()
  @IsString()
  installScript?: string;

  @IsOptional()
  @IsIn(SOFTWARE_KINDS)
  softwareKind?: SoftwareKind;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
