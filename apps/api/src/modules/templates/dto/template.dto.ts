import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { SOFTWARE_KINDS, type SoftwareKind } from '../software';
import { PRESET_KINDS, type PresetKind } from '../software-presets';

export class CreateTemplateGroupDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateTemplateVariableDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

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

  // Defaults to false server-side (schema default) if omitted — a brand
  // new template never becomes customer-facing by accident.
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  iconUrl?: string;
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

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  iconUrl?: string;
}

/**
 * The "criação rápida" wizard's payload (Admin Templates redesign) —
 * genuinely different shape from `CreateServerTemplateDto`: the admin
 * never sees `dockerImages`/`installScript`/individual variable rows at
 * all, only the software preset (`software-presets.ts`) plus the version/
 * build list they curated in the chip editor. `TemplatesService.
 * createFromPreset` is what expands this into a full
 * `CreateServerTemplateDto` and delegates to the existing `createTemplate`
 * — this DTO only carries what the wizard actually collects.
 */
export class CreateTemplateFromPresetDto {
  @IsString()
  groupId!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsIn(PRESET_KINDS)
  softwareKind!: PresetKind;

  @IsOptional()
  @IsString()
  description?: string;

  // The curated `MINECRAFT_VERSION` allow-list (`in:1.21.4,1.21.1,...`) —
  // at least one, or the client setup screen would offer a software with
  // literally no installable version (see PublicTemplatesService.
  // deriveOptionShape's `in:` -> `choices[]` derivation, the reader on
  // the other end of this list).
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  minecraftVersions!: string[];

  // The build/loader-version allow-list, when the preset has one
  // (`TemplatePreset.buildVariable !== null`) — Vanilla has none, so this
  // stays empty for it. Optional here; `createFromPreset` is what
  // enforces "required when the preset needs it," since that depends on
  // WHICH preset was chosen, not on this DTO's own shape.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  builds?: string[];

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class DuplicateTemplateDto {
  @IsString()
  @Length(1, 191)
  name!: string;
}
