import { IsEmail, IsString, Length } from 'class-validator';

/**
 * Public self-signup (commercial site, behind `ALLOW_PUBLIC_REGISTRATION`
 * — see AuthController.register's doc comment). Deliberately just
 * name/email/password/confirmation, per the commercial plan's "não pedir
 * informações desnecessárias" — no `username` field: `AuthService
 * .register` derives one from the email's local part, the same way a
 * customer never picks one today (only `CreateUserDto`, the ADMIN-facing
 * DTO, asks for it explicitly).
 */
export class RegisterDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @Length(8, 255)
  password!: string;

  @IsString()
  @Length(8, 255)
  confirmPassword!: string;
}
