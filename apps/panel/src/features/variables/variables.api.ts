import { apiFetch } from '@/shared/api/client';

export interface ServerVariable {
  id: string;
  name: string;
  description: string | null;
  envVariable: string;
  value: string;
  defaultValue: string;
  rules: string;
  isEditable: boolean;
}

export function listServerVariables(serverId: string) {
  return apiFetch<ServerVariable[]>(`/api/client/servers/${serverId}/variables`);
}

export function updateServerVariables(serverId: string, values: Record<string, string>) {
  return apiFetch<ServerVariable[]>(`/api/client/servers/${serverId}/variables`, {
    method: 'PATCH',
    body: JSON.stringify({ values }),
  });
}
