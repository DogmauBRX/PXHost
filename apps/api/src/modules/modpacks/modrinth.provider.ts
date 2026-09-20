import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModpackCacheService } from './modpack-cache.service';
import { ModpackProviderError } from './modpack-provider.error';
import type {
  ModpackMetadata,
  ModpackProject,
  ModpackProvider,
  ModpackSearchQuery,
  ModpackSearchResult,
  ModpackSummary,
  ModpackVersion,
} from './modpack-provider';

const API_BASE = 'https://api.modrinth.com/v2';
const MODPACK_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const PLUGIN_LOADERS = ['paper', 'purpur', 'spigot', 'bukkit', 'velocity', 'bungeecord', 'waterfall'];
const ALL_LOADERS = [...MODPACK_LOADERS, ...PLUGIN_LOADERS];
const SEARCH_TTL_SECONDS = 5 * 60;
const PROJECT_TTL_SECONDS = 15 * 60;
const VERSION_TTL_SECONDS = 5 * 60;
const METADATA_TTL_SECONDS = 6 * 60 * 60;

interface ModrinthSearchResponse {
  hits: Array<{
    project_id: string;
    slug?: string | null;
    title: string;
    author?: string | null;
    icon_url?: string | null;
    description: string;
    downloads: number;
    categories: string[];
    display_categories?: string[];
    versions: string[];
    date_modified: string;
  }>;
  total_hits: number;
  offset: number;
  limit: number;
}

interface ModrinthProjectResponse {
  id: string;
  slug?: string | null;
  title: string;
  description: string;
  body: string;
  categories: string[];
  additional_categories?: string[];
  game_versions: string[];
  loaders: string[];
  downloads: number;
  icon_url?: string | null;
  published: string;
  updated: string;
  team: string;
  gallery: Array<{ url: string; featured: boolean }>;
}

interface ModrinthTeamMember {
  role: string;
  user: { username: string };
}

interface ModrinthVersionResponse {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: 'release' | 'beta' | 'alpha';
  date_published: string;
  downloads: number;
  files: Array<{ filename: string; size: number; primary: boolean; url: string; hashes: { sha1?: string; sha512?: string } }>;
}

interface ModrinthGameVersion {
  version: string;
  version_type: string;
  date: string;
}

interface ModrinthCategory {
  name: string;
  project_type: string;
  header: string;
}

@Injectable()
export class ModrinthProvider implements ModpackProvider {
  readonly source = 'modrinth' as const;
  private readonly userAgent: string;

  constructor(
    private readonly cache: ModpackCacheService,
    config: ConfigService,
  ) {
    this.userAgent = config.get<string>('MODRINTH_USER_AGENT') ?? 'gxhost/hosting-panel/0.1.0';
  }

  search(query: ModpackSearchQuery): Promise<ModpackSearchResult> {
    return this.searchProjectType('modpack', query);
  }

  // Plugins share Modrinth's response shape with modpacks. Keeping this
  // provider boundary means the panel never talks to a third party directly.
  searchPlugins(query: ModpackSearchQuery): Promise<ModpackSearchResult> {
    return this.searchProjectType('plugin', query);
  }

  private searchProjectType(projectType: 'modpack' | 'plugin', query: ModpackSearchQuery): Promise<ModpackSearchResult> {
    return this.cache.remember(`modrinth:${projectType}:search`, query, SEARCH_TTL_SECONDS, async () => {
      const facets: string[][] = [[`project_type:${projectType}`]];
      if (query.minecraftVersion) facets.push([`versions:${query.minecraftVersion}`]);
      if (query.loader) facets.push([`categories:${query.loader}`]);
      if (query.category) facets.push([`categories:${query.category}`]);

      const params = new URLSearchParams({
        query: query.query ?? '',
        facets: JSON.stringify(facets),
        index: this.mapSort(query.sort),
        offset: String(query.offset),
        limit: String(query.limit),
      });
      const response = await this.request<ModrinthSearchResponse>(`/search?${params.toString()}`);
      return {
        items: response.hits.map((hit) => this.normalizeSearchHit(hit)),
        total: response.total_hits,
        offset: response.offset,
        limit: response.limit,
      };
    });
  }

  getProject(projectId: string): Promise<ModpackProject> {
    return this.getProjectType('modpack', projectId);
  }

  getPluginProject(projectId: string): Promise<ModpackProject> {
    return this.getProjectType('plugin', projectId);
  }

  private getProjectType(projectType: 'modpack' | 'plugin', projectId: string): Promise<ModpackProject> {
    return this.cache.remember(`modrinth:${projectType}:project`, projectId, PROJECT_TTL_SECONDS, async () => {
      const project = await this.request<ModrinthProjectResponse>(`/project/${encodeURIComponent(projectId)}`);
      let author: string | null = null;
      try {
        const members = await this.request<ModrinthTeamMember[]>(`/team/${encodeURIComponent(project.team)}/members`);
        author = (members.find((member) => member.role.toLowerCase() === 'owner') ?? members[0])?.user.username ?? null;
      } catch (error) {
        // Team attribution is useful but not required to render a valid project.
        if (error instanceof ModpackProviderError && error.reason === 'rate_limited') throw error;
      }
      const categories = this.contentCategories([...(project.categories ?? []), ...(project.additional_categories ?? [])]);
      return {
        source: this.source,
        projectId: project.id,
        slug: project.slug ?? project.id,
        name: project.title,
        author,
        icon: project.icon_url ?? null,
        description: project.description,
        body: project.body,
        downloads: project.downloads,
        categories,
        minecraftVersions: project.game_versions,
        loaders: project.loaders.filter((loader) => ALL_LOADERS.includes(loader.toLowerCase())),
        updatedAt: project.updated,
        publishedAt: project.published,
        gallery: project.gallery.map((item) => item.url),
        pageUrl: `https://modrinth.com/${projectType}/${project.slug ?? project.id}`,
      };
    });
  }

  getVersions(projectId: string, filters: { minecraftVersion?: string; loader?: string } = {}): Promise<ModpackVersion[]> {
    return this.cache.remember('modrinth:versions', { projectId, ...filters }, VERSION_TTL_SECONDS, async () => {
      const params = new URLSearchParams({ include_changelog: 'false' });
      if (filters.minecraftVersion) params.set('game_versions', JSON.stringify([filters.minecraftVersion]));
      if (filters.loader) params.set('loaders', JSON.stringify([filters.loader]));
      const rows = await this.request<ModrinthVersionResponse[]>(
        `/project/${encodeURIComponent(projectId)}/version?${params.toString()}`,
      );
      return rows.map((row) => this.normalizeVersion(row));
    });
  }

  getVersion(versionId: string): Promise<ModpackVersion> {
    return this.cache.remember('modrinth:version', versionId, VERSION_TTL_SECONDS, async () =>
      this.normalizeVersion(await this.request<ModrinthVersionResponse>(`/version/${encodeURIComponent(versionId)}`)),
    );
  }

  getMetadata(): Promise<ModpackMetadata> {
    return this.cache.remember('modrinth:metadata', 'v1', METADATA_TTL_SECONDS, async () => {
      const [versions, categories] = await Promise.all([
        this.request<ModrinthGameVersion[]>('/tag/game_version'),
        this.request<ModrinthCategory[]>('/tag/category'),
      ]);
      return {
        minecraftVersions: versions
          .filter((item) => item.version_type === 'release')
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
          .map((item) => item.version),
        loaders: [...MODPACK_LOADERS],
        categories: [...new Set(categories.filter((item) => item.project_type === 'modpack' && !ALL_LOADERS.includes(item.name)).map((item) => item.name))].sort(),
      };
    });
  }

  private normalizeSearchHit(hit: ModrinthSearchResponse['hits'][number]): ModpackSummary {
    const rawCategories = hit.display_categories ?? hit.categories;
    return {
      source: this.source,
      projectId: hit.project_id,
      slug: hit.slug ?? hit.project_id,
      name: hit.title,
      author: hit.author ?? null,
      icon: hit.icon_url ?? null,
      description: hit.description,
      downloads: hit.downloads,
      categories: this.contentCategories(rawCategories),
      minecraftVersions: hit.versions,
      loaders: rawCategories.filter((category) => ALL_LOADERS.includes(category.toLowerCase())),
      updatedAt: hit.date_modified,
    };
  }

  private normalizeVersion(row: ModrinthVersionResponse): ModpackVersion {
    return {
      source: this.source, versionId: row.id, projectId: row.project_id, name: row.name,
      versionNumber: row.version_number, minecraftVersions: row.game_versions,
      loaders: row.loaders.filter((loader) => ALL_LOADERS.includes(loader.toLowerCase())),
      releaseType: row.version_type, publishedAt: row.date_published, downloads: row.downloads,
      files: row.files.map((file) => ({ filename: file.filename, size: file.size, primary: file.primary, url: file.url, hashes: file.hashes })),
    };
  }

  private contentCategories(categories: string[]): string[] {
    return [...new Set(categories.filter((category) => !ALL_LOADERS.includes(category.toLowerCase())))];
  }

  private mapSort(sort: ModpackSearchQuery['sort']): string {
    return { relevance: 'relevance', popularity: 'follows', downloads: 'downloads', updated: 'updated' }[sort];
  }

  private async request<T>(path: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) return (await response.json()) as T;
        if (response.status === 404) {
          throw new ModpackProviderError(this.source, 'not_found', 'Modpack não encontrado.', HttpStatus.NOT_FOUND);
        }
        if (response.status === 429) {
          if (attempt === 0) {
            await this.delay(this.retryDelay(response, attempt));
            continue;
          }
          throw new ModpackProviderError(this.source, 'rate_limited', 'O Modrinth atingiu o limite de consultas. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS);
        }
        if (response.status >= 500 && attempt === 0) {
          await this.delay(this.retryDelay(response, attempt));
          continue;
        }
        throw new ModpackProviderError(this.source, 'unavailable', 'O Modrinth está temporariamente indisponível.');
      } catch (error) {
        if (error instanceof ModpackProviderError) throw error;
        if (attempt === 0) {
          await this.delay(150);
          continue;
        }
        throw new ModpackProviderError(this.source, 'unavailable', 'Não foi possível consultar o Modrinth agora.');
      }
    }
    throw new ModpackProviderError(this.source, 'unavailable', 'Não foi possível consultar o Modrinth agora.');
  }

  private retryDelay(response: Response, attempt: number): number {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1_000, 1_000);
    return 150 * 2 ** attempt;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
