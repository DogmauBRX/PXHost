import { IsObject, IsOptional, IsUUID } from 'class-validator';

/**
 * `POST /api/client/servers/:id/change-version` — swaps an already-`ready`
 * server's software/template (Vanilla ⇄ Paper ⇄ Forge ⇄ Fabric, or just a
 * different curated Minecraft version of the same one). Shaped like
 * `CompleteServerSetupDto` minus `name` — this never renames the server,
 * only its software — and reuses the exact same `templateId`/`variables`
 * contract so the version-picker modal can post to either endpoint with
 * the same payload shape.
 */
export class ChangeServerVersionDto {
  @IsUUID()
  templateId!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
