import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

// Every cron_* field is validated for real by attempting a cron-parser
// parse at create/update time (SchedulesService.computeNextRunAt) rather
// than a regex here — cron-parser already knows the full grammar
// (ranges, steps, lists, `L`/`W` etc.) far better than a hand-rolled
// pattern would, and a schedule that can't compute a next run time is
// rejected outright rather than silently never firing.
export class CreateScheduleDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  cronMinute?: string;

  @IsOptional()
  @IsString()
  cronHour?: string;

  @IsOptional()
  @IsString()
  cronDayOfMonth?: string;

  @IsOptional()
  @IsString()
  cronMonth?: string;

  @IsOptional()
  @IsString()
  cronDayOfWeek?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyWhenOnline?: boolean;
}

export class UpdateScheduleDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  cronMinute?: string;

  @IsOptional()
  @IsString()
  cronHour?: string;

  @IsOptional()
  @IsString()
  cronDayOfMonth?: string;

  @IsOptional()
  @IsString()
  cronMonth?: string;

  @IsOptional()
  @IsString()
  cronDayOfWeek?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyWhenOnline?: boolean;
}

// `tasks.action` carries a real DB CHECK constraint (0001_init:
// tasks_action_check) — the actual allowed vocabulary is
// ('command','power','backup','delete_files'), set when this project's
// schema was first designed, well before M10 implemented any of it. Only
// 'power' and 'backup' are wired up to real execution this milestone
// (the DoD: "nightly restart+backup runs unattended") — 'command' would
// need a live console WS session a background worker doesn't have, and
// 'delete_files' is out of scope — so the application-level allowlist
// here is deliberately narrower than what the DB would technically
// accept; a stricter app-level check than the DB's outer bound is fine.
export const TASK_ACTIONS = ['power', 'backup'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export class CreateTaskDto {
  @IsIn(TASK_ACTIONS)
  action!: TaskAction;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  timeOffsetSeconds?: number;

  @IsOptional()
  @IsBoolean()
  continueOnFailure?: boolean;
}
