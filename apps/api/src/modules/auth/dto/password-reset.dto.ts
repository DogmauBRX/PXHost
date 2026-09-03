import { IsEmail, IsString, Length } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
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
