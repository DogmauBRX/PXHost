import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

// firstName/lastName/username/email all optional (a PATCH, not a PUT) —
// email additionally requires currentPassword to be present in the SAME
// request (checked in AccountService, not expressible as a DTO-level
// rule): email is the target of any future account-recovery flow, so a
// leaked-but-still-valid access token shouldn't be enough on its own to
// silently redirect it. See the plan's design-decision #2.
//
// Billing fields (cpf/billing*) are collected only at checkout time, not
// signup — see the User model's own schema.prisma comment. They're all
// optional here too: AccountService checks real CPF-checksum validity
// and "all-or-nothing" completeness, neither of which is a DTO-level
// shape rule. billingCountry is intentionally absent — server-managed,
// not client-editable (see schema.prisma).
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

  // Accepted with or without punctuation (000.000.000-00 or 00000000000)
  // — AccountService.updateProfile normalizes to digits-only and runs the
  // real checksum via cpf.util.ts; the length bound here just rejects
  // garbage before it reaches that logic.
  @IsOptional()
  @IsString()
  @Length(11, 14)
  cpf?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{5}-?\d{3}$/, { message: 'billingPostalCode must be a valid CEP' })
  billingPostalCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  billingAddressLine?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  billingAddressNumber?: string;

  // The one billing field that's genuinely allowed to be empty (not
  // every address has a complement) — @Length(0, ...) rather than the
  // (1, ...) every other required-together billing field uses.
  @IsOptional()
  @IsString()
  @Length(0, 255)
  billingAddressComplement?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  billingNeighborhood?: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  billingCity?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'billingState must be a 2-letter UF code' })
  billingState?: string;
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
