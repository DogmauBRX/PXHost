import { apiFetch } from '@/shared/api/client';
import type { CreatedDatabase, DatabaseSummary } from '@/shared/api/types';

const base = (serverId: string) => `/api/client/servers/${serverId}/databases`;

export function listDatabases(serverId: string) {
  return apiFetch<DatabaseSummary[]>(base(serverId));
}

export function createDatabase(serverId: string, name?: string) {
  return apiFetch<CreatedDatabase>(base(serverId), { method: 'POST', body: JSON.stringify({ name }) });
}

export function deleteDatabase(serverId: string, databaseId: string) {
  return apiFetch<void>(`${base(serverId)}/${databaseId}`, { method: 'DELETE' });
}
