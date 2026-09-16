import { apiFetch } from '@/shared/api/client';

export type VariableOptionKind = 'text' | 'integer' | 'boolean' | 'choice';

export interface ServerVariable {
  id: string;
  name: string;
  description: string | null;
  envVariable: string;
  value: string;
  defaultValue: string;
  rules: string;
  isEditable: boolean;
  // Derived server-side from `rules` — 'choice' means the admin curated a
  // fixed value list (e.g. real Minecraft versions), so this renders as
  // a dropdown instead of free text.
  kind: VariableOptionKind;
  choices?: string[];
  min?: number;
  max?: number;
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
