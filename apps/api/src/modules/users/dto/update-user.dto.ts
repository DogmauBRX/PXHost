import { IsIn, IsOptional, IsString, Length } from 'class-validator';

const GLOBAL_ROLES = ['user', 'support', 'admin', 'root_admin'] as const;

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  email?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  username?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  lastName?: string;

  @IsOptional()
  @IsIn(GLOBAL_ROLES)
  globalRole?: (typeof GLOBAL_ROLES)[number];
}
