import { apiFetch } from '@/shared/api/client';
import type { Schedule, ScheduleTask, TaskAction } from '@/shared/api/types';

const base = (serverId: string) => `/api/client/servers/${serverId}/schedules`;

export function listSchedules(serverId: string) {
  return apiFetch<Schedule[]>(base(serverId));
}

export interface CreateScheduleInput {
  name: string;
  cronMinute?: string;
  cronHour?: string;
  cronDayOfMonth?: string;
  cronMonth?: string;
  cronDayOfWeek?: string;
  timezone?: string;
  onlyWhenOnline?: boolean;
}

export function createSchedule(serverId: string, input: CreateScheduleInput) {
  return apiFetch<Schedule>(base(serverId), { method: 'POST', body: JSON.stringify(input) });
}

export function updateSchedule(serverId: string, scheduleId: string, input: Partial<CreateScheduleInput & { isActive: boolean }>) {
  return apiFetch<Schedule>(`${base(serverId)}/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteSchedule(serverId: string, scheduleId: string) {
  return apiFetch<void>(`${base(serverId)}/${scheduleId}`, { method: 'DELETE' });
}

export function addTask(serverId: string, scheduleId: string, action: TaskAction, timeOffsetSeconds?: number, continueOnFailure?: boolean) {
  return apiFetch<ScheduleTask>(`${base(serverId)}/${scheduleId}/tasks`, { method: 'POST', body: JSON.stringify({ action, timeOffsetSeconds, continueOnFailure }) });
}

export function deleteTask(serverId: string, scheduleId: string, taskId: string) {
  return apiFetch<void>(`${base(serverId)}/${scheduleId}/tasks/${taskId}`, { method: 'DELETE' });
}
