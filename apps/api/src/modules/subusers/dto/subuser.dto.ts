import { ArrayUnique, IsArray, IsEmail, IsString } from 'class-validator';

export class InviteSubuserDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateSubuserPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}
