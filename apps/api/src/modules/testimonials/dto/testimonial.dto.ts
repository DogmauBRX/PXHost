import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class SubmitTestimonialDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsString() @Length(10, 1000) message!: string;
}

export class ModerateTestimonialDto {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: 'pending' | 'approved' | 'rejected';
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsInt() @Min(0) featuredOrder?: number;
}
