import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class InstallModpackDto {
  @IsIn(['modrinth']) source!: 'modrinth';
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
