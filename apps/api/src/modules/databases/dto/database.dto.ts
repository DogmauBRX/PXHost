import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateDatabaseDto {
  // Becomes the suffix of the real MySQL identifier (`s<shortId>_<name>`,
  // see DatabasesService.sanitizeSuffix) — lowercase alphanumeric +
  // underscore only, since it's interpolated directly into DDL (MySQL has
  // no placeholder syntax for identifiers) rather than bound as a value.
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(/^[a-z0-9_]+$/, { message: 'name must be lowercase alphanumeric with underscores only' })
  name?: string;
}
