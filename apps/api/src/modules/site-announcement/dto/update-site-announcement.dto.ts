import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSiteAnnouncementDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
