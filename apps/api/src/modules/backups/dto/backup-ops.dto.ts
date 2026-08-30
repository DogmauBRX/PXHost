import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateBackupDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ignorePatterns?: string[];
}
