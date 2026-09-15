import { IsBoolean, IsIP, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateGatewayDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  // The address a customer's Minecraft client actually connects to —
  // never a private/tunnel address. Loosely validated like
  // Node.controlAddress (bare IP or hostname both valid).
  @IsString()
  @Length(1, 255)
  publicHost!: string;

  @IsIP()
  tunnelIp!: string;

  @IsString()
  @Matches(/^https?:\/\/[^\s/]+$/, { message: 'controlUrl must look like http(s)://host[:port]' })
  controlUrl!: string;
}

export class UpdateGatewayDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  publicHost?: string;

  @IsOptional()
  @IsIP()
  tunnelIp?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/[^\s/]+$/, { message: 'controlUrl must look like http(s)://host[:port]' })
  controlUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
