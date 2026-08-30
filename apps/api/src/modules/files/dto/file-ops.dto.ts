import { IsArray, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class WriteFileDto {
  @IsString()
  @Length(0, 2_000_000)
  content!: string;
}

export class RenameFileDto {
  @IsString()
  from!: string;

  @IsString()
  to!: string;
}

export class MkdirDto {
  @IsString()
  path!: string;
}

export class ChmodDto {
  @IsString()
  path!: string;

  @IsInt()
  @Min(0)
  @Max(0o777)
  mode!: number;
}

export class CompressDto {
  @IsArray()
  @IsString({ each: true })
  paths!: string[];

  @IsString()
  dest!: string;
}

export class DecompressDto {
  @IsString()
  path!: string;

  @IsString()
  dest!: string;
}

export class DownloadLinkDto {
  @IsString()
  path!: string;
}

export class UploadLinkDto {
  @IsString()
  path!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxBytes?: number;
}

export class DeleteFileDto {
  @IsString()
  path!: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  recursive?: string;
}
