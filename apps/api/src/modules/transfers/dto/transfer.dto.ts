import { IsOptional, IsUUID } from 'class-validator';

export class InitiateTransferDto {
  @IsUUID()
  targetNodeId!: string;

  @IsOptional()
  @IsUUID()
  targetAllocationId?: string;
}
