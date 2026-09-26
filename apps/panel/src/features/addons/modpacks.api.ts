import { apiFetch } from '@/shared/api/client';

export type ModpackSource = 'modrinth' | 'curseforge';
export type ModpackSort = 'relevance' | 'popularity' | 'downloads' | 'updated';

export interface ModpackSummary {
  source: ModpackSource;
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

export interface ModpackProject extends ModpackSummary {
  body: string;
  gallery: string[];
  pageUrl: string;
  publishedAt: string;
}

export interface ModpackVersion {
  source: ModpackSource;
  versionId: string;
  projectId: string;
  name: string;
  versionNumber: string;
  minecraftVersions: string[];
  loaders: string[];
  releaseType: 'release' | 'beta' | 'alpha';
  publishedAt: string;
  downloads: number;
  files: Array<{ filename: string; size: number; primary: boolean; distributable?: boolean; distributionMessage?: string }>;
}

export interface ModpackSearchResult {
  items: ModpackSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface ModpackMetadata {
  minecraftVersions: string[];
  loaders: string[];
  categories: string[];
}

export interface ModpackInstallation {
  id: string;
  source: string;
  projectId: string;
  versionId: string;
  projectName: string;
  versionName: string;
  minecraftVersion: string;
  loader: string;
  status: 'pending' | 'downloading' | 'installing' | 'configuring' | 'rolling_back' | 'completed' | 'failed' | 'uninstalled';
  progress: number;
  message: string | null;
  backupId: string | null;
  errorMessage: string | null;
  /** CurseForge mods the author restricts to manual download; installed without them. */
  manualFiles: Array<{ name: string; filename: string; pageUrl: string }> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SearchModpacksParams {
  query?: string;
  minecraftVersion?: string;
  loader?: string;
  category?: string;
  sort: ModpackSort;
  offset: number;
  limit: number;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  return params.toString();
}

export function searchModpacks(serverId: string, source: ModpackSource, params: SearchModpacksParams) {
  return apiFetch<ModpackSearchResult>(`/api/client/servers/${serverId}/modpacks/search?${queryString({ source, ...params })}`);
}

export function getModpackMetadata(serverId: string, source: ModpackSource) {
  return apiFetch<ModpackMetadata>(`/api/client/servers/${serverId}/modpacks/${source}/metadata`);
}

export function getModpackProject(serverId: string, source: ModpackSource, projectId: string) {
  return apiFetch<ModpackProject>(`/api/client/servers/${serverId}/modpacks/${source}/${encodeURIComponent(projectId)}`);
}

export function getModpackVersions(serverId: string, source: ModpackSource, projectId: string) {
  return apiFetch<ModpackVersion[]>(`/api/client/servers/${serverId}/modpacks/${source}/${encodeURIComponent(projectId)}/versions`);
}

export function installModpack(serverId: string, source: ModpackSource, projectId: string, versionId: string) {
  return apiFetch<ModpackInstallation>(`/api/client/servers/${serverId}/modpacks/installations`, {
    method: 'POST',
    body: JSON.stringify({ source, projectId, versionId }),
  });
}

export function getLatestModpackInstallation(serverId: string) {
  return apiFetch<ModpackInstallation | null>(`/api/client/servers/${serverId}/modpacks/installations/latest`);
}

export function uninstallLatestModpack(serverId: string) {
  return apiFetch<void>(`/api/client/servers/${serverId}/modpacks/installations/latest`, { method: 'DELETE' });
}
