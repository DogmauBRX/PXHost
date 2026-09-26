import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class InstallModpackDto {
  @IsIn(['modrinth', 'curseforge']) source!: 'modrinth' | 'curseforge';
  @IsString() projectId!: string;
  @IsString() versionId!: string;
}

export class ModpackProgressDto {
  @IsUUID() operationId!: string;
  @IsIn(['downloading', 'installing', 'configuring', 'completed', 'failed', 'rolling_back']) status!: string;
  @IsInt() @Min(0) @Max(100) progress!: number;
  @IsString() message!: string;
  @IsOptional() @IsString() backupId?: string;
  @IsOptional() @IsString() errorMessage?: string;
}

export class CurseForgeManifestFileDto {
  @IsInt() @Min(1) projectId!: number;
  @IsInt() @Min(1) fileId!: number;
}

/** Called only by a node while it processes a previously-authorized install. */
export class ResolveCurseForgeFilesDto {
  @IsUUID() operationId!: string;
  @IsArray() @ArrayMaxSize(1_000) @ValidateNested({ each: true }) @Type(() => CurseForgeManifestFileDto)
  files!: CurseForgeManifestFileDto[];
}
