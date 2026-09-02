import { IsObject } from 'class-validator';

export class UpdateServerVariablesDto {
  @IsObject()
  values!: Record<string, string>;
}
