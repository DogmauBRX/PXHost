import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateLocationDto {
  @IsString()
  @Length(1, 32)
  @Matches(/^[a-z0-9-]+$/, { message: 'shortCode must be lowercase alphanumeric with hyphens only' })
  shortCode!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}
