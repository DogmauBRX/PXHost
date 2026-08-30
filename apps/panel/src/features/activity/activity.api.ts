import { apiFetch } from '@/shared/api/client';
import type { ActivityEntry } from '@/shared/api/types';

export function listActivity(serverId: string) {
  return apiFetch<ActivityEntry[]>(`/api/client/servers/${serverId}/activity`);
}
