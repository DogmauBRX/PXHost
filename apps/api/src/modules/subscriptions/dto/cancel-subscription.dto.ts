import { IsOptional, IsString, Length } from 'class-validator';

export class CancelSubscriptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
