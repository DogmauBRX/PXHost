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

// CurseForge project classes that never belong on a dedicated server.
const CLIENT_ONLY_CLASS_IDS = new Set([12 /* resource packs */, 6552 /* shaders */]);
const ALLOWED_CDN_HOSTS = new Set(['edge.forgecdn.net', 'mediafilez.forgecdn.net']);

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
  classId?: number | null;
}

interface CurseForgeFile {
  id: number;
  modId: number;
  displayName?: string | null;
  fileName: string;
  /** null when the author disallows distribution through third-party apps. */
  downloadUrl?: string | null;
  isServerPack?: boolean | null;
  releaseType: number;
  fileDate: string;
  fileLength: number;
  downloadCount?: number;
  gameVersions?: string[];
  hashes?: Array<{ value: string; algo: number }>;
}

export interface CurseForgeFileRequest {
  projectId: number;
  fileId: number;
}

export interface CurseForgeResolvedFile extends CurseForgeFileRequest {
  filename: string;
  size: number;
  url: string;
  sha1: string;
  /** Not installed by the Agent: client-only content, or a restricted file (see manual). */
  skip: boolean;
  /** Set when the author disallows third-party downloads; the client adds it by hand. */
  manual?: { name: string; pageUrl: string };
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
      // Server packs are ready-made server trees without a manifest.json; only
      // client packs follow the manifest format the Agent installs.
      return response.data.filter((file) => !file.isServerPack).map((file) => this.normalizeVersion(file, projectId));
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

  /**
   * Resolves the files declared inside a CurseForge manifest for a trusted
   * node. The Agent never receives the CurseForge API key: it only gets CDN
   * URLs and hashes after the Panel validates the active installation.
   */
  async resolveFiles(requests: CurseForgeFileRequest[]): Promise<CurseForgeResolvedFile[]> {
    if (requests.length === 0) return [];
    const distinct = [...new Map(requests.map((item) => [item.fileId, item])).values()];
    if (distinct.length > 1_000) throw new ModpackProviderError(this.source, 'invalid_response', 'O modpack declara arquivos demais para uma instalação segura.', HttpStatus.UNPROCESSABLE_ENTITY);
    const [fileResponse, modResponse] = await Promise.all([
      this.request<{ data: CurseForgeFile[] }>('/mods/files', { method: 'POST', body: { fileIds: distinct.map((item) => item.fileId) } }),
      this.request<{ data: CurseForgeMod[] }>('/mods', { method: 'POST', body: { modIds: [...new Set(distinct.map((item) => item.projectId))] } }),
    ]);
    const files = new Map(fileResponse.data.map((file) => [file.id, file]));
    const mods = new Map(modResponse.data.map((mod) => [mod.id, mod]));

    const resolved: CurseForgeResolvedFile[] = [];
    for (const requested of distinct) {
      const file = files.get(requested.fileId);
      if (!file || file.modId !== requested.projectId) throw new ModpackProviderError(this.source, 'invalid_response', 'Um arquivo declarado pelo modpack não pôde ser validado no CurseForge.', HttpStatus.UNPROCESSABLE_ENTITY);
      const mod = mods.get(file.modId);
      const skip = (mod?.classId != null && CLIENT_ONLY_CLASS_IDS.has(mod.classId)) || isClientOnlyFile(file);
      if (skip) {
        resolved.push({ ...requested, filename: file.fileName, size: file.fileLength, url: '', sha1: '', skip: true });
        continue;
      }
      if (!file.downloadUrl) {
        const projectPage = mod?.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${mod?.slug ?? file.modId}`;
        resolved.push({
          ...requested, filename: file.fileName, size: file.fileLength, url: '', sha1: '', skip: true,
          manual: { name: mod?.name ?? file.displayName ?? file.fileName, pageUrl: `${projectPage.replace(/\/$/, '')}/files/${file.id}` },
        });
        continue;
      }
      const sha1 = file.hashes?.find((hash) => hash.algo === 1)?.value;
      if (!sha1 || !file.fileName || file.fileLength <= 0) throw new ModpackProviderError(this.source, 'invalid_response', `O arquivo ${file.fileName || file.id} não possui os dados necessários para uma instalação segura.`, HttpStatus.UNPROCESSABLE_ENTITY);
      resolved.push({ ...requested, filename: file.fileName, size: file.fileLength, url: assertAllowedCdnUrl(file.downloadUrl), sha1, skip: false });
    }
    return resolved;
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
    const url = allowedCdnUrlOrEmpty(file.downloadUrl);
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
      // An empty url marks a pack whose author disallows third-party downloads;
      // the install flow refuses it with an explanation instead of guessing a CDN path.
      files: [{
        filename: file.fileName, size: file.fileLength, primary: true, url, hashes: sha1 ? { sha1 } : {},
        distributable: Boolean(url),
        ...(url ? {} : { distributionMessage: 'O autor desta versão não permite download por aplicativos de terceiros.' }),
      }],
    };
  }

  private async request<T>(path: string, init: { method?: 'POST'; body?: unknown } = {}): Promise<T> {
    if (!this.apiKey) throw new ModpackProviderError('curseforge', 'unavailable', 'O catálogo do CurseForge ainda não foi configurado pelo administrador.', HttpStatus.SERVICE_UNAVAILABLE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          method: init.method,
          headers: { Accept: 'application/json', 'x-api-key': this.apiKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
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

// CurseForge tags a file's environment inside gameVersions; "Client" without
// "Server" means the author declares it client-only. Untagged files are kept.
function isClientOnlyFile(file: CurseForgeFile): boolean {
  const tags = new Set((file.gameVersions ?? []).map((value) => value.toLowerCase()));
  return tags.has('client') && !tags.has('server');
}

function allowedCdnUrlOrEmpty(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return assertAllowedCdnUrl(raw);
  } catch {
    return '';
  }
}

function assertAllowedCdnUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModpackProviderError('curseforge', 'invalid_response', 'O CurseForge retornou um link de download inválido.', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_CDN_HOSTS.has(url.hostname)) {
    throw new ModpackProviderError('curseforge', 'invalid_response', 'O CurseForge retornou um link de download fora do CDN permitido.', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return url.toString();
}
