import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;

  // Cloudflare Turnstile widget token — see LoginDto's own comment for
  // why this stays optional in the DTO regardless of server-side config.
  @IsOptional()
  @IsString()
  captchaToken?: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(1, 512)
  token!: string;

  @IsString()
  @Length(8, 255)
  newPassword!: string;

  @IsString()
  @Length(8, 255)
  confirmPassword!: string;
}
