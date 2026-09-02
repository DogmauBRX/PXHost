import { IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateServerDto {
  @IsUUID()
  ownerId!: string;

  // Capacity plan Fase 5: omitted ⇒ automatic node selection
  // (NodeSchedulerService). Every existing caller already sends this,
  // so nothing changes for them.
  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsUUID()
  templateId!: string;

  @IsUUID()
  planId!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @IsUUID()
  allocationId?: string;
}

export class SuspendServerDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
