import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModpackCacheService } from '../modpacks/modpack-cache.service';
import { ModpackProviderError } from '../modpacks/modpack-provider.error';
import type { ModpackMetadata, ModpackProject, ModpackProvider, ModpackSearchQuery, ModpackSearchResult, ModpackSummary, ModpackVersion } from '../modpacks/modpack-provider';

const API_BASE = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MINECRAFT_MODPACKS_CLASS_ID = 4471;
const SEARCH_TTL_SECONDS = 5 * 60;
const PROJECT_TTL_SECONDS = 15 * 60;
const VERSION_TTL_SECONDS = 5 * 60;

const LOADER_TYPES: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

const LOADER_NAMES: Record<number, string> = {
  1: 'forge',
  4: 'fabric',
  5: 'quilt',
  6: 'neoforge',
};

const SORT_FIELDS: Record<ModpackSearchQuery['sort'], number> = {
  relevance: 1,
  popularity: 2,
  updated: 3,
  downloads: 6,
};

interface CurseForgeMod {
  id: number;
  slug?: string | null;
  name: string;
  summary?: string | null;
  downloadCount?: number;
  dateModified?: string;
  dateCreated?: string;
  links?: { websiteUrl?: string | null };
  logo?: { thumbnailUrl?: string | null; url?: string | null } | null;
  authors?: Array<{ name?: string | null }>;
  categories?: Array<{ name?: string | null; slug?: string | null }>;
  latestFilesIndexes?: Array<{ gameVersion?: string; modLoader?: number }>;
  screenshots?: Array<{ thumbnailUrl?: string | null; url?: string | null }>;
}

interface CurseForgeFile {
  id: number;
  modId: number;
  displayName?: string | null;
  fileName: string;
  releaseType: number;
  fileDate: string;
  fileLength: number;
  downloadCount?: number;
  gameVersions?: string[];
  hashes?: Array<{ value: string; algo: number }>;
}

interface CurseForgeSearchResponse {
  data: CurseForgeMod[];
  pagination: { index: number; pageSize: number; totalCount: number };
}

@Injectable()
export class CurseForgeProvider implements ModpackProvider {
  readonly source = 'curseforge' as const;
  private readonly apiKey?: string;

  constructor(
    private readonly cache: ModpackCacheService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('CURSEFORGE_API_KEY');
  }

  search(query: ModpackSearchQuery): Promise<ModpackSearchResult> {
    const loaderType = query.loader ? LOADER_TYPES[query.loader.toLowerCase()] : undefined;
    if (query.loader && !loaderType) throw new ModpackProviderError(this.source, 'invalid_response', 'O loader selecionado não é compatível com o catálogo do CurseForge.', HttpStatus.CONFLICT);
    return this.cache.remember('curseforge:modpacks:search', query, SEARCH_TTL_SECONDS, async () => {
      const params = new URLSearchParams({
        gameId: String(MINECRAFT_GAME_ID),
        classId: String(MINECRAFT_MODPACKS_CLASS_ID),
        searchFilter: query.query ?? '',
        sortField: String(SORT_FIELDS[query.sort]),
        sortOrder: 'desc',
        index: String(query.offset),
        pageSize: String(Math.min(50, query.limit)),
      });
      if (query.minecraftVersion) params.set('gameVersion', query.minecraftVersion);
      if (loaderType) params.set('modLoaderType', String(loaderType));
      const response = await this.request<CurseForgeSearchResponse>(`/mods/search?${params.toString()}`);
      return {
        items: response.data.map((mod) => this.normalizeSummary(mod)),
        total: response.pagination.totalCount,
        offset: response.pagination.index,
        limit: response.pagination.pageSize,
      };
    });
  }

  getProject(projectId: string): Promise<ModpackProject> {
    return this.cache.remember('curseforge:modpacks:project', projectId, PROJECT_TTL_SECONDS, async () => {
      const response = await this.request<{ data: CurseForgeMod }>(`/mods/${encodeURIComponent(projectId)}`);
      const mod = response.data;
      return {
        ...this.normalizeSummary(mod),
        body: mod.summary ?? '',
        gallery: (mod.screenshots ?? []).map((item) => item.url ?? item.thumbnailUrl).filter((url): url is string => Boolean(url)),
        pageUrl: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/modpacks/${mod.slug ?? mod.id}`,
        publishedAt: mod.dateCreated ?? mod.dateModified ?? new Date(0).toISOString(),
      };
    });
  }

  getVersions(projectId: string, filters: { minecraftVersion?: string; loader?: string } = {}): Promise<ModpackVersion[]> {
    const loaderType = filters.loader ? LOADER_TYPES[filters.loader.toLowerCase()] : undefined;
    if (filters.loader && !loaderType) throw new ModpackProviderError(this.source, 'invalid_response', 'O loader selecionado não é compatível com o catálogo do CurseForge.', HttpStatus.CONFLICT);
    return this.cache.remember('curseforge:modpacks:versions', { projectId, ...filters }, VERSION_TTL_SECONDS, async () => {
      const params = new URLSearchParams({ index: '0', pageSize: '50' });
      if (filters.minecraftVersion) params.set('gameVersion', filters.minecraftVersion);
      if (loaderType) params.set('modLoaderType', String(loaderType));
      const response = await this.request<{ data: CurseForgeFile[] }>(`/mods/${encodeURIComponent(projectId)}/files?${params.toString()}`);
      return response.data.map((file) => this.normalizeVersion(file, projectId));
    });
  }

  getVersion(versionId: string, projectId?: string): Promise<ModpackVersion> {
    if (!projectId) throw new ModpackProviderError(this.source, 'invalid_response', 'O modpack da versão não foi informado.', HttpStatus.BAD_REQUEST);
    return this.cache.remember('curseforge:modpacks:version', { projectId, versionId }, VERSION_TTL_SECONDS, async () => {
      const response = await this.request<{ data: CurseForgeFile }>(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`);
      if (String(response.data.modId) !== projectId) throw new ModpackProviderError('curseforge', 'not_found', 'Versão do modpack não encontrada.', HttpStatus.NOT_FOUND);
      return this.normalizeVersion(response.data, projectId);
    });
  }

  getMetadata(): Promise<ModpackMetadata> {
    return Promise.resolve({ minecraftVersions: [], loaders: Object.keys(LOADER_TYPES), categories: [] });
  }

  private normalizeSummary(mod: CurseForgeMod): ModpackSummary {
    const indexes = mod.latestFilesIndexes ?? [];
    return {
      source: this.source,
      projectId: String(mod.id),
      slug: mod.slug ?? String(mod.id),
      name: mod.name,
      author: mod.authors?.find((author) => author.name)?.name ?? null,
      icon: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null,
      description: mod.summary ?? '',
      downloads: mod.downloadCount ?? 0,
      categories: (mod.categories ?? []).map((category) => category.slug ?? category.name).filter((value): value is string => Boolean(value)),
      minecraftVersions: [...new Set(indexes.map((item) => item.gameVersion).filter((value): value is string => Boolean(value)))],
      loaders: [...new Set(indexes.map((item) => item.modLoader).map((type) => LOADER_NAMES[type ?? -1]).filter((value): value is string => Boolean(value)))],
      updatedAt: mod.dateModified ?? new Date(0).toISOString(),
    };
  }

  private normalizeVersion(file: CurseForgeFile, projectId: string): ModpackVersion {
    const sha1 = file.hashes?.find((hash) => hash.algo === 1)?.value;
    const gameVersions = file.gameVersions ?? [];
    return {
      source: this.source,
      versionId: String(file.id),
      projectId,
      name: file.displayName ?? file.fileName,
      versionNumber: file.displayName ?? file.fileName,
      minecraftVersions: gameVersions.filter((value) => /^1\.\d+(\.\d+)?(?:-pre\d+)?$/i.test(value)),
      loaders: gameVersions.map((value) => value.toLowerCase()).filter((value) => Object.keys(LOADER_TYPES).includes(value)),
      releaseType: file.releaseType === 1 ? 'release' : file.releaseType === 2 ? 'beta' : 'alpha',
      publishedAt: file.fileDate,
      downloads: file.downloadCount ?? 0,
      files: [{ filename: file.fileName, size: file.fileLength, primary: true, url: '', hashes: sha1 ? { sha1 } : {} }],
    };
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.apiKey) throw new ModpackProviderError('curseforge', 'unavailable', 'O catálogo do CurseForge ainda não foi configurado pelo administrador.', HttpStatus.SERVICE_UNAVAILABLE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          headers: { Accept: 'application/json', 'x-api-key': this.apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return (await response.json()) as T;
        if (response.status === 404) throw new ModpackProviderError('curseforge', 'not_found', 'Modpack não encontrado no CurseForge.', HttpStatus.NOT_FOUND);
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        if (response.status === 429) throw new ModpackProviderError('curseforge', 'rate_limited', 'O CurseForge atingiu o limite de consultas. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS);
        throw new ModpackProviderError('curseforge', 'unavailable', 'Não foi possível consultar o CurseForge agora.');
      } catch (error) {
        if (error instanceof ModpackProviderError) throw error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw new ModpackProviderError('curseforge', 'unavailable', 'Não foi possível consultar o CurseForge agora.');
      }
    }
    throw new ModpackProviderError('curseforge', 'unavailable', 'Não foi possível consultar o CurseForge agora.');
  }
}
