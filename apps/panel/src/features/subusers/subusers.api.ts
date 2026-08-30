import { apiFetch } from '@/shared/api/client';
import type { PermissionCatalogEntry, Subuser } from '@/shared/api/types';

const base = (serverId: string) => `/api/client/servers/${serverId}/subusers`;

export function listSubusers(serverId: string) {
  return apiFetch<Subuser[]>(base(serverId));
}

export function inviteSubuser(serverId: string, email: string, permissions: string[]) {
  return apiFetch<Subuser>(base(serverId), { method: 'POST', body: JSON.stringify({ email, permissions }) });
}

export function updateSubuserPermissions(serverId: string, subuserId: string, permissions: string[]) {
  return apiFetch<Subuser>(`${base(serverId)}/${subuserId}`, { method: 'PATCH', body: JSON.stringify({ permissions }) });
}

export function removeSubuser(serverId: string, subuserId: string) {
  return apiFetch<void>(`${base(serverId)}/${subuserId}`, { method: 'DELETE' });
}

export function listPermissionCatalog() {
  return apiFetch<PermissionCatalogEntry[]>('/api/client/permission-catalog');
}
