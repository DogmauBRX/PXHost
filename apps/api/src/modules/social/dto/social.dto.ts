import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class SearchUsersDto {
  @IsString()
  @Length(2, 64)
  q!: string;
}

export class PublishServerDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;
}
