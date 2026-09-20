import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModpackCacheService } from './modpack-cache.service';
import { ModpackProviderError } from './modpack-provider.error';
import type { ModpackMetadata, ModpackProject, ModpackProvider, ModpackSearchQuery, ModpackSearchResult, ModpackSummary, ModpackVersion } from './modpack-provider';

const DEFAULT_API_BASE = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MODPACK_CLASS_ID = 4471;
const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const SEARCH_TTL_SECONDS = 5 * 60;
const PROJECT_TTL_SECONDS = 15 * 60;
const VERSION_TTL_SECONDS = 5 * 60;
const METADATA_TTL_SECONDS = 6 * 60 * 60;

interface CurseForgeEnvelope<T> {
  data: T;
  pagination?: { index: number; pageSize: number; resultCount: number; totalCount: number };
}

interface CurseForgeCategory { id: number; name: string; slug?: string; }
interface CurseForgeFileIndex { gameVersion: string; fileId: number; filename: string; releaseType: number; modLoader?: number; }
interface CurseForgeMod {
  id: number; name: string; slug?: string; summary?: string; downloadCount?: number; dateModified: string; dateCreated: string;
  authors?: Array<{ name: string }>; logo?: { thumbnailUrl?: string | null; url?: string | null } | null;
  categories?: CurseForgeCategory[]; latestFilesIndexes?: CurseForgeFileIndex[]; links?: { websiteUrl?: string | null };
}
interface CurseForgeFile {
  id: number; modId: number; displayName?: string; fileName: string; releaseType: number; fileDate: string;
  fileLength: number; downloadCount: number; downloadUrl?: string | null; hashes?: Array<{ value: string; algo: number }>; gameVersions?: string[];
}
interface CurseForgeMinecraftVersion { versionString: string; }

/**
 * Official CurseForge catalog adapter. It owns the API key and all upstream
 * response shapes, so neither the browser nor the Agent receives a secret.
 * A null downloadUrl means distribution is not permitted; a URL is never
 * guessed or synthesized.
 */
@Injectable()
export class CurseForgeProvider implements ModpackProvider {
  readonly source = 'curseforge' as const;
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;

  constructor(private readonly cache: ModpackCacheService, config: ConfigService) {
    this.apiKey = config.get<string>('CURSEFORGE_API_KEY') || undefined;
    this.apiBase = (config.get<string>('CURSEFORGE_API_BASE_URL') || DEFAULT_API_BASE).replace(/\/$/, '');
  }

  search(query: ModpackSearchQuery): Promise<ModpackSearchResult> {
    return this.cache.remember('curseforge:search', query, SEARCH_TTL_SECONDS, async () => {
      const params = new URLSearchParams({
        gameId: String(MINECRAFT_GAME_ID), classId: String(MODPACK_CLASS_ID), index: String(query.offset),
        pageSize: String(query.limit), sortField: String(this.sortField(query.sort)), sortOrder: 'desc',
      });
      if (query.query) params.set('searchFilter', query.query);
      if (query.minecraftVersion) params.set('gameVersion', query.minecraftVersion);
      const loader = this.loaderType(query.loader);
      if (loader !== undefined) params.set('modLoaderType', String(loader));
      const result = await this.request<CurseForgeEnvelope<CurseForgeMod[]>>(`/mods/search?${params.toString()}`);
      return {
        items: result.data.map((mod) => this.normalizeSummary(mod)),
        total: result.pagination?.totalCount ?? result.data.length,
        offset: result.pagination?.index ?? query.offset,
        limit: result.pagination?.pageSize ?? query.limit,
      };
    });
  }

  getProject(projectId: string): Promise<ModpackProject> {
    return this.cache.remember('curseforge:project', projectId, PROJECT_TTL_SECONDS, async () => {
      const mod = (await this.request<CurseForgeEnvelope<CurseForgeMod>>(`/mods/${this.id(projectId)}`)).data;
      const summary = this.normalizeSummary(mod);
      return {
        ...summary, body: mod.summary ?? '', gallery: [],
        pageUrl: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/modpacks/${summary.slug}`,
        publishedAt: mod.dateCreated,
      };
    });
  }

  getVersions(projectId: string, filters: { minecraftVersion?: string; loader?: string } = {}): Promise<ModpackVersion[]> {
    return this.cache.remember('curseforge:versions', { projectId, ...filters }, VERSION_TTL_SECONDS, async () => {
      const rows = await this.files(projectId);
      return rows.map((file) => this.normalizeVersion(file)).filter((version) =>
        (!filters.minecraftVersion || version.minecraftVersions.includes(filters.minecraftVersion))
        && (!filters.loader || version.loaders.includes(filters.loader)));
    });
  }

  getVersion(versionId: string, projectId?: string): Promise<ModpackVersion> {
    if (!projectId) throw new ModpackProviderError(this.source, 'not_found', 'A release CurseForge precisa do modpack de origem.', HttpStatus.BAD_REQUEST);
    return this.cache.remember('curseforge:version', { versionId, projectId }, VERSION_TTL_SECONDS, async () =>
      this.normalizeVersion((await this.request<CurseForgeEnvelope<CurseForgeFile>>(`/mods/${this.id(projectId)}/files/${this.id(versionId)}`)).data),
    );
  }

  getMetadata(): Promise<ModpackMetadata> {
    return this.cache.remember('curseforge:metadata', 'v1', METADATA_TTL_SECONDS, async () => {
      const [versions, categories] = await Promise.all([
        this.request<CurseForgeEnvelope<CurseForgeMinecraftVersion[]>>('/minecraft/version'),
        this.request<CurseForgeEnvelope<CurseForgeCategory[]>>(`/categories?gameId=${MINECRAFT_GAME_ID}&classId=${MODPACK_CLASS_ID}`),
      ]);
      return {
        minecraftVersions: versions.data.map((item) => item.versionString).filter((item) => /^\d+\.\d+/.test(item)),
        loaders: LOADERS,
        categories: categories.data.map((item) => item.slug ?? item.name).filter(Boolean).sort(),
      };
    });
  }

  private async files(projectId: string): Promise<CurseForgeFile[]> {
    return (await this.request<CurseForgeEnvelope<CurseForgeFile[]>>(`/mods/${this.id(projectId)}/files?pageSize=50&index=0`)).data;
  }

  private normalizeSummary(mod: CurseForgeMod): ModpackSummary {
    const labels = (mod.latestFilesIndexes ?? []).flatMap((item) => [item.gameVersion, this.loaderFromType(item.modLoader)]).filter((value): value is string => Boolean(value));
    return {
      source: this.source, projectId: String(mod.id), slug: mod.slug ?? String(mod.id), name: mod.name,
      author: mod.authors?.[0]?.name ?? null, icon: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null,
      description: mod.summary ?? '', downloads: mod.downloadCount ?? 0,
      categories: (mod.categories ?? []).map((category) => category.slug ?? category.name),
      minecraftVersions: this.minecraftVersions(labels), loaders: this.loaders(labels), updatedAt: mod.dateModified,
    };
  }

  private normalizeVersion(file: CurseForgeFile): ModpackVersion {
    const downloadable = Boolean(file.downloadUrl);
    const sha1 = file.hashes?.find((hash) => hash.algo === 1)?.value;
    return {
      source: this.source, versionId: String(file.id), projectId: String(file.modId),
      name: file.displayName || file.fileName, versionNumber: file.fileName,
      minecraftVersions: this.minecraftVersions(file.gameVersions ?? []), loaders: this.loaders(file.gameVersions ?? []),
      releaseType: ({ 1: 'release', 2: 'beta', 3: 'alpha' } as Record<number, 'release' | 'beta' | 'alpha'>)[file.releaseType] ?? 'release',
      publishedAt: file.fileDate, downloads: file.downloadCount,
      files: [{
        filename: file.fileName, size: file.fileLength, primary: true, url: file.downloadUrl ?? '', hashes: sha1 ? { sha1 } : {},
        distributable: downloadable,
        distributionMessage: downloadable ? undefined : 'O autor não autorizou a distribuição automática deste arquivo pelo CurseForge. Use a página oficial para obter o pacote.',
      }],
    };
  }

  private minecraftVersions(values: string[]): string[] { return [...new Set(values.filter((value) => /^\d+\.\d+/.test(value)))]; }
  private loaders(values: string[]): string[] { return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => LOADERS.includes(value)))]; }
  private loaderFromType(type: number | undefined): string | undefined { return ({ 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' } as Record<number, string | undefined>)[type ?? -1]; }
  private loaderType(loader: string | undefined): number | undefined { return loader ? ({ forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as Record<string, number | undefined>)[loader] : undefined; }
  private sortField(sort: ModpackSearchQuery['sort']): number { return ({ relevance: 1, popularity: 2, updated: 3, downloads: 6 } as Record<ModpackSearchQuery['sort'], number>)[sort]; }

  private id(value: string): number {
    if (!/^\d+$/.test(value)) throw new ModpackProviderError(this.source, 'not_found', 'Modpack CurseForge não encontrado.', HttpStatus.NOT_FOUND);
    return Number(value);
  }

  private async request<T>(path: string): Promise<T> {
    const apiKey = this.apiKey;
    if (!apiKey) throw new ModpackProviderError(this.source, 'unavailable', 'O catálogo CurseForge ainda precisa da chave CURSEFORGE_API_KEY configurada no servidor.', HttpStatus.SERVICE_UNAVAILABLE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.apiBase}${path}`, {
          headers: { Accept: 'application/json', 'x-api-key': apiKey },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) return (await response.json()) as T;
        if (response.status === 404) throw new ModpackProviderError(this.source, 'not_found', 'Modpack CurseForge não encontrado.', HttpStatus.NOT_FOUND);
        if (response.status === 429) {
          if (attempt === 0) { await this.delay(500); continue; }
          throw new ModpackProviderError(this.source, 'rate_limited', 'O CurseForge atingiu o limite de consultas. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS);
        }
        if (response.status >= 500 && attempt === 0) { await this.delay(200); continue; }
        throw new ModpackProviderError(this.source, 'unavailable', 'O CurseForge está temporariamente indisponível.');
      } catch (error) {
        if (error instanceof ModpackProviderError) throw error;
        if (attempt === 0) { await this.delay(200); continue; }
        throw new ModpackProviderError(this.source, 'unavailable', 'Não foi possível consultar o CurseForge agora.');
      }
    }
    throw new ModpackProviderError(this.source, 'unavailable', 'Não foi possível consultar o CurseForge agora.');
  }

  private delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
