import { apiFetch } from '@/shared/api/client';
import type { ConsoleTokenResponse, PowerAction, ServerDetail, ServerSetupInfo, ServerStatsSnapshot, ServerSummary } from '@/shared/api/types';

export function listServers() {
  return apiFetch<ServerSummary[]>('/api/client/servers');
}

export function getServer(id: string) {
  return apiFetch<ServerDetail>(`/api/client/servers/${id}`);
}

// ---- Post-purchase setup (ServerSetupPage/ServerInstallingPage) ----

export function getServerSetup(id: string) {
  return apiFetch<ServerSetupInfo>(`/api/client/servers/${id}/setup`);
}

export interface CompleteServerSetupInput {
  name: string;
  templateId: string;
  variables?: Record<string, string>;
}
// The exact same call whether this is the FIRST setup or a retry after
// install_failed — ServerSetupService.complete's CAS accepts both source
// statuses, so there is deliberately no separate "retry" endpoint/function.
export function completeServerSetup(id: string, input: CompleteServerSetupInput) {
  return apiFetch<{ id: string; status: string }>(`/api/client/servers/${id}/setup`, { method: 'POST', body: JSON.stringify(input) });
}

// ---- Change version (VersionPickerModal) — a server already `ready`, not the post-purchase flow above ----

export interface ChangeServerVersionInput {
  templateId: string;
  variables?: Record<string, string>;
}
// Reuses `getServerSetup`'s own catalog response as the picker's data
// source — GET .../setup has no status precondition (see
// ServerSetupService.getSetupInfo), so it already works for a `ready`
// server exactly as-is.
export function changeServerVersion(id: string, input: ChangeServerVersionInput) {
  return apiFetch<{ id: string; status: string }>(`/api/client/servers/${id}/change-version`, { method: 'POST', body: JSON.stringify(input) });
}

export function reinstallCurrentServerVersion(id: string) {
  return apiFetch<{ id: string; status: string }>(`/api/client/servers/${id}/reinstall`, { method: 'POST' });
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
