import { IsIn } from 'class-validator';

export class PowerActionDto {
  @IsIn(['start', 'stop', 'restart', 'kill'])
  action!: 'start' | 'stop' | 'restart' | 'kill';
}
