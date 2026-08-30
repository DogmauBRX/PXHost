import { apiFetch } from '@/shared/api/client';
import type { ConsoleTokenResponse, PowerAction, ServerDetail, ServerSummary } from '@/shared/api/types';

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
