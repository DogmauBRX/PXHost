import { apiFetch } from '@/shared/api/client';

export type PluginSort = 'relevance' | 'popularity' | 'downloads' | 'updated';

export interface PluginSummary {
  projectId: string;
  slug: string;
  name: string;
  author: string | null;
  icon: string | null;
  description: string;
  downloads: number;
  categories: string[];
  minecraftVersions: string[];
  loaders: string[];
  updatedAt: string;
}

export interface PluginProject extends PluginSummary {
  body: string;
  gallery: string[];
  pageUrl: string;
  publishedAt: string;
}

export interface PluginVersion {
  versionId: string;
  projectId: string;
  name: string;
  versionNumber: string;
  minecraftVersions: string[];
  loaders: string[];
  releaseType: 'release' | 'beta' | 'alpha';
  publishedAt: string;
  downloads: number;
  files: Array<{ filename: string; size: number; primary: boolean }>;
}

export interface PluginSearchResult {
  items: PluginSummary[];
  total: number;
  offset: number;
  limit: number;
}

function queryString(values: Record<string, string | number>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => params.set(key, String(value)));
  return params.toString();
}

export function searchPlugins(serverId: string, query: string, sort: PluginSort, offset: number) {
  return apiFetch<PluginSearchResult>(`/api/client/servers/${serverId}/plugins/modrinth/search?${queryString({ query, sort, offset })}`);
}

export function getPluginProject(serverId: string, projectId: string) {
  return apiFetch<PluginProject>(`/api/client/servers/${serverId}/plugins/modrinth/${encodeURIComponent(projectId)}`);
}

export function getPluginVersions(serverId: string, projectId: string) {
  return apiFetch<PluginVersion[]>(`/api/client/servers/${serverId}/plugins/modrinth/${encodeURIComponent(projectId)}/versions`);
}

export function installPlugin(serverId: string, projectId: string, versionId: string) {
  return apiFetch<{ fileName: string; versionName: string; message: string }>(`/api/client/servers/${serverId}/plugins/modrinth/install`, {
    method: 'POST',
    body: JSON.stringify({ projectId, versionId }),
  });
}
