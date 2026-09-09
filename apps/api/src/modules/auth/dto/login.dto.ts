import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  // Cloudflare Turnstile widget token — optional in the DTO regardless of
  // whether TURNSTILE_SECRET_KEY is configured server-side (a client with
  // no VITE_TURNSTILE_SITE_KEY simply never sends one); TurnstileService
  // enforces presence only when the feature is actually turned on.
  @IsOptional()
  @IsString()
  captchaToken?: string;
}
