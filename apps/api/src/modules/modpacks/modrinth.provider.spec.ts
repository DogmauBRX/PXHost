import { ConfigService } from '@nestjs/config';
import { ModrinthProvider } from './modrinth.provider';
import type { ModpackCacheService } from './modpack-cache.service';

describe('ModrinthProvider', () => {
  const cache = {
    remember: jest.fn(async (_namespace: string, _identity: unknown, _ttl: number, load: () => Promise<unknown>) => load()),
  } as unknown as ModpackCacheService;
  const config = { get: jest.fn(() => 'gxhost/test') } as unknown as ConfigService;
  let provider: ModrinthProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new ModrinthProvider(cache, config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('builds modpack facets and normalizes search results', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [{
          project_id: 'abc123', slug: 'better-mc', title: 'Better MC', author: 'LunaPixelStudios',
          icon_url: 'https://cdn.modrinth.com/icon.png', description: 'A pack', downloads: 42,
          categories: ['adventure', 'fabric'], display_categories: ['adventure', 'fabric'],
          versions: ['1.21.1'], date_modified: '2026-01-01T00:00:00Z',
        }],
        total_hits: 1, offset: 20, limit: 20,
      }),
    } as Response);

    const result = await provider.search({
      query: 'better', minecraftVersion: '1.21.1', loader: 'fabric', category: 'adventure',
      sort: 'downloads', offset: 20, limit: 20,
    });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(JSON.parse(calledUrl.searchParams.get('facets')!)).toEqual([
      ['project_type:modpack'], ['versions:1.21.1'], ['categories:fabric'], ['categories:adventure'],
    ]);
    expect(calledUrl.searchParams.get('index')).toBe('downloads');
    expect(result.items[0]).toMatchObject({
      source: 'modrinth', projectId: 'abc123', slug: 'better-mc', name: 'Better MC',
      author: 'LunaPixelStudios', loaders: ['fabric'], categories: ['adventure'],
    });
  });

  it('passes only real version combinations through the normalized response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{
        id: 'version-1', project_id: 'project-1', name: 'Release 32', version_number: 'v32',
        game_versions: ['1.21.1'], loaders: ['fabric'], version_type: 'release',
        date_published: '2026-02-01T00:00:00Z', downloads: 10,
        files: [{ filename: 'pack.mrpack', size: 1234, primary: true, url: 'https://cdn.modrinth.com/pack.mrpack', hashes: { sha1: 'abc' } }],
      }],
    } as Response);

    const versions = await provider.getVersions('project-1', { minecraftVersion: '1.21.1', loader: 'fabric' });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(JSON.parse(calledUrl.searchParams.get('game_versions')!)).toEqual(['1.21.1']);
    expect(JSON.parse(calledUrl.searchParams.get('loaders')!)).toEqual(['fabric']);
    expect(versions[0]).toEqual({
      source: 'modrinth', versionId: 'version-1', projectId: 'project-1', name: 'Release 32', versionNumber: 'v32',
      minecraftVersions: ['1.21.1'], loaders: ['fabric'], releaseType: 'release', publishedAt: '2026-02-01T00:00:00Z',
      downloads: 10, files: [{ filename: 'pack.mrpack', size: 1234, primary: true, url: 'https://cdn.modrinth.com/pack.mrpack', hashes: { sha1: 'abc' } }],
    });
  });

  it('keeps plugin loaders and requests only plugin projects', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [{
          project_id: 'plugin-1', slug: 'example-plugin', title: 'Example Plugin', author: 'Author',
          icon_url: null, description: 'A Paper plugin', downloads: 100,
          categories: ['paper', 'bukkit', 'management'], display_categories: ['paper', 'bukkit', 'management'],
          versions: ['1.21.1'], date_modified: '2026-03-01T00:00:00Z',
        }],
        total_hits: 1, offset: 0, limit: 20,
      }),
    } as Response);

    const result = await provider.searchPlugins({
      query: '', minecraftVersion: '1.21.1', loader: 'paper', sort: 'downloads', offset: 0, limit: 20,
    });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(JSON.parse(calledUrl.searchParams.get('facets')!)).toEqual([
      ['project_type:plugin'], ['versions:1.21.1'], ['categories:paper'],
    ]);
    expect(result.items[0]).toMatchObject({ loaders: ['paper', 'bukkit'], categories: ['management'] });
  });

  it('sends the identifying user agent required by Modrinth', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ hits: [], total_hits: 0, offset: 0, limit: 20 }),
    } as Response);
    await provider.search({ sort: 'relevance', offset: 0, limit: 20 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Accept: 'application/json', 'User-Agent': 'gxhost/test' } });
  });
});
