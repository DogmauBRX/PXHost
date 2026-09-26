import { ConfigService } from '@nestjs/config';
import { CurseForgeProvider } from './curseforge.provider';
import type { ModpackCacheService } from '../modpacks/modpack-cache.service';

describe('CurseForgeProvider', () => {
  const cache = {
    remember: jest.fn(async (_namespace: string, _identity: unknown, _ttl: number, load: () => Promise<unknown>) => load()),
  } as unknown as ModpackCacheService;
  const config = { get: jest.fn(() => 'test-key') } as unknown as ConfigService;
  let provider: CurseForgeProvider;

  const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  function mockCurseForge(files: unknown[], mods: unknown[]) {
    return jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/mods/files')) return jsonResponse({ data: files });
      if (url.endsWith('/mods')) return jsonResponse({ data: mods });
      throw new Error(`unexpected request ${url}`);
    });
  }

  const file = (overrides: Record<string, unknown> = {}) => ({
    id: 5001, modId: 10, fileName: 'mod.jar', releaseType: 1, fileDate: '2026-01-01T00:00:00Z', fileLength: 123,
    downloadUrl: 'https://edge.forgecdn.net/files/5/1/mod.jar', hashes: [{ algo: 1, value: 'abc' }],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new CurseForgeProvider(cache, config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('resolves manifest files using the official download URL and never sends the key to the CDN', async () => {
    const fetchMock = mockCurseForge([file()], [{ id: 10, name: 'Mod', classId: 6 }]);

    const resolved = await provider.resolveFiles([{ projectId: 10, fileId: 5001 }]);

    expect(resolved).toEqual([{ projectId: 10, fileId: 5001, filename: 'mod.jar', size: 123, url: 'https://edge.forgecdn.net/files/5/1/mod.jar', sha1: 'abc', skip: false }]);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://api.curseforge.com/'))).toBe(true);
  });

  it('skips restricted mods for manual install instead of guessing a CDN path', async () => {
    mockCurseForge([file({ downloadUrl: null })], [{ id: 10, name: 'Restricted Mod', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/restricted/' } }]);

    const [resolved] = await provider.resolveFiles([{ projectId: 10, fileId: 5001 }]);

    expect(resolved).toMatchObject({ skip: true, url: '', manual: { name: 'Restricted Mod', pageUrl: 'https://www.curseforge.com/minecraft/mc-mods/restricted/files/5001' } });
  });

  it('marks resource packs and shaders as skipped without requiring a download URL', async () => {
    mockCurseForge([file({ downloadUrl: null })], [{ id: 10, name: 'Shader', classId: 6552 }]);

    const [resolved] = await provider.resolveFiles([{ projectId: 10, fileId: 5001 }]);

    expect(resolved.skip).toBe(true);
    expect(resolved.url).toBe('');
  });

  it('skips files tagged Client-only, even when their download is restricted, but keeps Client+Server files', async () => {
    mockCurseForge([
      file({ id: 5001, modId: 10, downloadUrl: null, gameVersions: ['Client', '1.20.1', 'Forge'] }),
      file({ id: 5002, modId: 11, fileName: 'both.jar', gameVersions: ['Client', 'Server', '1.20.1', 'Forge'] }),
    ], [{ id: 10, name: 'Client Mod', classId: 6 }, { id: 11, name: 'Both Mod', classId: 6 }]);

    const resolved = await provider.resolveFiles([{ projectId: 10, fileId: 5001 }, { projectId: 11, fileId: 5002 }]);

    expect(resolved.map((item) => [item.fileId, item.skip])).toEqual([[5001, true], [5002, false]]);
  });

  it('rejects a file that belongs to a different project than the manifest declared', async () => {
    mockCurseForge([file({ modId: 99 })], [{ id: 99, name: 'Other', classId: 6 }]);

    await expect(provider.resolveFiles([{ projectId: 10, fileId: 5001 }])).rejects.toThrow(/não pôde ser validado/);
  });

  it('rejects download URLs outside the CurseForge CDN', async () => {
    mockCurseForge([file({ downloadUrl: 'https://evil.example/mod.jar' })], [{ id: 10, name: 'Mod', classId: 6 }]);

    await expect(provider.resolveFiles([{ projectId: 10, fileId: 5001 }])).rejects.toThrow(/fora do CDN permitido/);
  });

  it('hides server packs from the version list and leaves restricted packs without a URL', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ data: [
      file({ id: 7001, modId: 10, fileName: 'pack.zip', gameVersions: ['1.20.1', 'Forge'] }),
      file({ id: 7002, modId: 10, fileName: 'server.zip', isServerPack: true }),
      file({ id: 7003, modId: 10, fileName: 'locked.zip', downloadUrl: null }),
    ] }));

    const versions = await provider.getVersions('10');

    expect(versions.map((version) => version.versionId)).toEqual(['7001', '7003']);
    expect(versions[0].files[0].url).toBe('https://edge.forgecdn.net/files/5/1/mod.jar');
    expect(versions[0].loaders).toEqual(['forge']);
    expect(versions[1].files[0].url).toBe('');
    expect(versions[1].files[0].distributable).toBe(false);
  });
});
