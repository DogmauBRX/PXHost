import { apiFetch } from '@/shared/api/client';

export type PluginSort = 'relevance' | 'popularity' | 'downloads' | 'updated';
export type PluginSource = 'modrinth' | 'curseforge';

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

export function searchPlugins(serverId: string, query: string, sort: PluginSort, offset: number, source: PluginSource = 'modrinth') {
  return apiFetch<PluginSearchResult>(`/api/client/servers/${serverId}/plugins/${source}/search?${queryString({ query, sort, offset })}`);
}

export function getPluginProject(serverId: string, projectId: string, source: PluginSource = 'modrinth') {
  return apiFetch<PluginProject>(`/api/client/servers/${serverId}/plugins/${source}/${encodeURIComponent(projectId)}`);
}

export function getPluginVersions(serverId: string, projectId: string, source: PluginSource = 'modrinth') {
  return apiFetch<PluginVersion[]>(`/api/client/servers/${serverId}/plugins/${source}/${encodeURIComponent(projectId)}/versions`);
}

export function installPlugin(serverId: string, projectId: string, versionId: string, source: PluginSource = 'modrinth') {
  return apiFetch<{ fileName: string; versionName: string; message: string }>(`/api/client/servers/${serverId}/plugins/${source}/install`, {
    method: 'POST',
    body: JSON.stringify({ projectId, versionId }),
  });
}
