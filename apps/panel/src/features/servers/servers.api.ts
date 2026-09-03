import { apiFetch } from '@/shared/api/client';
import type { ConsoleTokenResponse, PowerAction, ServerDetail, ServerStatsSnapshot, ServerSummary } from '@/shared/api/types';

export function listServers() {
  return apiFetch<ServerSummary[]>('/api/client/servers');
}

export function getServer(id: string) {
  return apiFetch<ServerDetail>(`/api/client/servers/${id}`);
}

export function sendPowerAction(id: string, action: PowerAction) {
  return apiFetch<{ state: string; previous: string }>(`/api/client/servers/${id}/power`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export function mintConsoleToken(id: string) {
  return apiFetch<ConsoleTokenResponse>(`/api/client/servers/${id}/console-token`, { method: 'POST' });
}

export function getServerStats(id: string) {
  return apiFetch<ServerStatsSnapshot>(`/api/client/servers/${id}/stats`);
}

// On-demand, not live — a genuine filesystem walk on the agent, server-
// side cached for a while (see ClientServersService.diskUsage). Call this
// from a "refresh" action, never on a polling interval.
export interface DiskUsageSnapshot {
  usedBytes: number | null;
  limitBytes: number | null;
  measuredAt: string;
}
export function getServerDiskUsage(id: string) {
  return apiFetch<DiskUsageSnapshot>(`/api/client/servers/${id}/disk-usage`);
}
