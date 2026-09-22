export type ModpackSource = 'modrinth';
export type ModpackSort = 'relevance' | 'popularity' | 'downloads' | 'updated';

export interface ModpackSearchQuery {
  query?: string;
  minecraftVersion?: string;
  loader?: string;
  category?: string;
  sort: ModpackSort;
  offset: number;
  limit: number;
}

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
  files: Array<{
    filename: string;
    size: number;
    primary: boolean;
    url: string;
    hashes: { sha1?: string; sha512?: string };
    distributable?: boolean;
    distributionMessage?: string;
  }>;
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

/** Provider boundary: provider-specific response shapes never leave this module. */
export interface ModpackProvider {
  readonly source: ModpackSource;
  search(query: ModpackSearchQuery): Promise<ModpackSearchResult>;
  getProject(projectId: string): Promise<ModpackProject>;
  getVersions(projectId: string, filters?: { minecraftVersion?: string; loader?: string }): Promise<ModpackVersion[]>;
  getVersion(versionId: string, projectId?: string): Promise<ModpackVersion>;
  getMetadata(): Promise<ModpackMetadata>;
}
