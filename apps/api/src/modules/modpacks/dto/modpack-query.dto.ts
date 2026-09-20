import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import type { ModpackSort, ModpackSource } from '../modpack-provider';

const SAFE_FILTER = /^[a-zA-Z0-9_.+\- ]+$/;

export class SearchModpacksDto {
  @IsOptional()
  @IsIn(['modrinth', 'curseforge'])
  source: ModpackSource = 'modrinth';

  @IsOptional()
  @IsString()
  @Length(0, 100)
  query?: string;

  @IsOptional()
  @IsString()
  @Matches(SAFE_FILTER)
  minecraftVersion?: string;

  @IsOptional()
  @IsIn(['fabric', 'forge', 'neoforge', 'quilt'])
  loader?: string;

  @IsOptional()
  @IsString()
  @Matches(SAFE_FILTER)
  category?: string;

  @IsOptional()
  @IsIn(['relevance', 'popularity', 'downloads', 'updated'])
  sort: ModpackSort = 'relevance';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class ListModpackVersionsDto {
  @IsOptional()
  @IsString()
  @Matches(SAFE_FILTER)
  minecraftVersion?: string;

  @IsOptional()
  @IsIn(['fabric', 'forge', 'neoforge', 'quilt'])
  loader?: string;
}
