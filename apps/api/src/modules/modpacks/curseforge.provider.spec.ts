import { ConfigService } from '@nestjs/config';
import { CurseForgeProvider } from './curseforge.provider';
import type { ModpackCacheService } from './modpack-cache.service';

describe('CurseForgeProvider', () => {
  const cache = {
    remember: jest.fn(async (_namespace: string, _identity: unknown, _ttl: number, load: () => Promise<unknown>) => load()),
  } as unknown as ModpackCacheService;

  afterEach(() => jest.restoreAllMocks());

  it('uses the official API key header and normalizes a modpack search', async () => {
    const config = { get: jest.fn((key: string) => key === 'CURSEFORGE_API_KEY' ? 'test-key' : undefined) } as unknown as ConfigService;
    const provider = new CurseForgeProvider(cache, config);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: 123, name: 'All The Mods', slug: 'all-the-mods-10', summary: 'A modpack', downloadCount: 42,
          dateModified: '2026-01-01T00:00:00Z', dateCreated: '2025-01-01T00:00:00Z',
          authors: [{ name: 'ATM Team' }], logo: { thumbnailUrl: 'https://example.test/icon.png' },
          categories: [{ id: 1, name: 'Tech', slug: 'tech' }],
          latestFilesIndexes: [{ gameVersion: '1.21.1', fileId: 7, filename: 'atm.zip', releaseType: 1, modLoader: 1 }],
        }],
        pagination: { index: 20, pageSize: 20, resultCount: 1, totalCount: 100 },
      }),
    } as Response);

    const result = await provider.search({ query: 'atm', minecraftVersion: '1.21.1', loader: 'forge', sort: 'downloads', offset: 20, limit: 20 });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v1/mods/search');
    expect(url.searchParams.get('gameId')).toBe('432');
    expect(url.searchParams.get('classId')).toBe('4471');
    expect(url.searchParams.get('modLoaderType')).toBe('1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Accept: 'application/json', 'x-api-key': 'test-key' } });
    expect(result).toMatchObject({
      total: 100,
      items: [{ source: 'curseforge', projectId: '123', slug: 'all-the-mods-10', author: 'ATM Team', loaders: ['forge'] }],
    });
  });

  it('keeps a blocked distribution explicit instead of inventing a download URL', async () => {
    const config = { get: jest.fn((key: string) => key === 'CURSEFORGE_API_KEY' ? 'test-key' : undefined) } as unknown as ConfigService;
    const provider = new CurseForgeProvider(cache, config);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: {
        id: 7, modId: 123, displayName: 'Release', fileName: 'release.zip', releaseType: 1,
        fileDate: '2026-01-01T00:00:00Z', fileLength: 1024, downloadCount: 1,
        downloadUrl: null, gameVersions: ['1.21.1', 'Forge'], hashes: [],
      } }),
    } as Response);

    const version = await provider.getVersion('7', '123');

    expect(version.files[0]).toMatchObject({ url: '', distributable: false });
    expect(version.files[0].distributionMessage).toContain('não autorizou');
  });

  it('refuses use when the API key is not configured without affecting other providers', async () => {
    const provider = new CurseForgeProvider(cache, { get: jest.fn(() => undefined) } as unknown as ConfigService);
    await expect(provider.search({ sort: 'relevance', offset: 0, limit: 20 })).rejects.toMatchObject({ status: 503 });
  });
});
