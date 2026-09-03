import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

// firstName/lastName/username/email all optional (a PATCH, not a PUT) —
// email additionally requires currentPassword to be present in the SAME
// request (checked in AccountService, not expressible as a DTO-level
// rule): email is the target of any future account-recovery flow, so a
// leaked-but-still-valid access token shouldn't be enough on its own to
// silently redirect it. See the plan's design-decision #2.
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  username?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @Length(8, 255)
  newPassword!: string;

  @IsString()
  @Length(8, 255)
  confirmPassword!: string;
}
