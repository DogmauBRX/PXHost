import { IsString, Length, Matches, ValidateIf } from 'class-validator';
import { HOSTNAME_LABEL_MAX_LENGTH, HOSTNAME_LABEL_MIN_LENGTH, HOSTNAME_LABEL_PATTERN } from '../../gateway/hostname-policy';

/** Body of `PATCH /api/client/servers/:serverId/hostname` — `hostname: null` clears the reservation, a string sets/renames it. */
export class UpdateServerHostnameDto {
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(HOSTNAME_LABEL_MIN_LENGTH, HOSTNAME_LABEL_MAX_LENGTH)
  @Matches(HOSTNAME_LABEL_PATTERN, {
    message: 'hostname deve conter apenas letras minúsculas, números e hífens, sem começar ou terminar com hífen',
  })
  hostname!: string | null;
}
