import { IsObject, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class BillingEventDataDto {
  @IsString()
  serverId!: string;
}

export class BillingEventDto {
  @IsString()
  id!: string;

  @IsString()
  type!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => BillingEventDataDto)
  data!: BillingEventDataDto;
}
