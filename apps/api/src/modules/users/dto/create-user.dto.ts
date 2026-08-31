import { IsIn, IsOptional, IsString, Length } from 'class-validator';

// Mirrors the users_global_role_check CHECK constraint (0001_init) exactly
// — this is the same closed set ListUsersDto filters by.
const GLOBAL_ROLES = ['user', 'support', 'admin', 'root_admin'] as const;

export class CreateUserDto {
  @IsString()
  @Length(1, 191)
  email!: string;

  @IsString()
  @Length(1, 191)
  username!: string;

  // No upper bound beyond what argon2 itself accepts — a long passphrase
  // is a feature, not a problem. 8 is the minimum any admin-set temporary
  // password should be, matching the account's own security posture.
  @IsString()
  @Length(8, 255)
  password!: string;

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
