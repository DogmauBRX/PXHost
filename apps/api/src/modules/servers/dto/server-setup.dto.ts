import { IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/**
 * `POST /api/client/servers/:id/setup` — the ONLY write a customer ever
 * makes to a `setup_pending`/`install_failed` server. Deliberately shaped
 * like the client-facing subset of `CreateServerDto` (name/templateId/
 * variables), not like it structurally reused — this DTO is bound by the
 * global `ValidationPipe`, `CreateServerDto` is not.
 *
 * `templateId` is genuinely a UUID the client only ever gets from THIS
 * server's own `GET .../setup` response (`software[].id`, itself sourced
 * from `PublicTemplatesService.list()` — already filtered to
 * `isPublic && isActive`). `ServerSetupService.complete` re-checks that
 * filter server-side rather than trusting the id alone, exactly like
 * `ServersService.create` never trusts a bare `templateId` either.
 *
 * `variables` stays optional and generic (not a fixed `{ minecraftVersion }`
 * field) on purpose: `resolveDeclaredVariables` already knows how to
 * reject anything not `isUserViewable && isUserEditable` on the chosen
 * template, so a future template with a second customer-editable option
 * works here with zero DTO changes — same posture `CreateServerDto.variables`
 * already has for the admin path.
 */
export class CompleteServerSetupDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsUUID()
  templateId!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
