import { SoftwareDiscoveryService } from './software-discovery.service';
import { RedisService } from '../../core/redis/redis.service';

/** In-memory stand-in for the one Redis operation this service touches — same "avoid a live connection in a unit test" reasoning capability-token.service.spec.ts already documents for its own fake Prisma. */
function makeFakeRedis(): RedisService {
  const store = new Map<string, string>();
  return {
    client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    },
  } as unknown as RedisService;
}

function mockFetchOnce(body: unknown, ok = true): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe('SoftwareDiscoveryService', () => {
  let redis: RedisService;
  let service: SoftwareDiscoveryService;

  beforeEach(() => {
    redis = makeFakeRedis();
    service = new SoftwareDiscoveryService(redis);
    global.fetch = jest.fn();
  });

  it('returns Paper versions newest-first, flattened from fill.papermc.io\'s per-minor-version grouping', async () => {
    mockFetchOnce({ project: { id: 'paper' }, versions: { '1.21': ['1.21.4', '1.21.1'], '1.20': ['1.20.6'] } });
    const versions = await service.getVersions('paper');
    expect(versions).toEqual(['1.21.4', '1.21.1', '1.20.6']);
  });

  it('Paper builds map the fill.papermc.io build objects down to their numeric id, newest-first', async () => {
    mockFetchOnce([
      { id: 232, channel: 'STABLE' },
      { id: 231, channel: 'STABLE' },
    ]);
    const builds = await service.getBuilds('paper', '1.21.4');
    expect(builds).toEqual(['232', '231']);
  });

  it('degrades to [] — never throws — when the upstream API is down', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.getVersions('paper')).resolves.toEqual([]);
  });

  it('degrades to [] when the upstream responds but not with 2xx', async () => {
    mockFetchOnce({}, false);
    await expect(service.getVersions('purpur')).resolves.toEqual([]);
  });

  it('degrades to [] when the response shape is unexpected (no "versions" field)', async () => {
    mockFetchOnce({ somethingElse: true });
    await expect(service.getVersions('paper')).resolves.toEqual([]);
  });

  it('caches a successful result — a second call for the same kind never calls fetch again', async () => {
    mockFetchOnce({ project: { id: 'paper' }, versions: { '1.21': ['1.21.4'] } });
    await service.getVersions('paper');
    await service.getVersions('paper');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('Fabric loader versions only include stable releases', async () => {
    mockFetchOnce([
      { version: '0.16.5', stable: true },
      { version: '0.17.0-beta.1', stable: false },
    ]);
    const loaders = await service.getBuilds('fabric', '1.21.4');
    expect(loaders).toEqual(['0.16.5']);
  });

  it('Quilt game versions only include stable releases', async () => {
    mockFetchOnce([
      { version: '1.21.11', stable: true },
      { version: '26.3-pre-1', stable: false },
    ]);
    await expect(service.getVersions('quilt')).resolves.toEqual(['1.21.11']);
  });

  it('Quilt loader versions exclude prereleases while preserving upstream order', async () => {
    mockFetchOnce([
      { version: '0.31.0-beta.4' },
      { version: '0.30.1' },
      { version: '0.30.0-rc.1' },
      { version: '0.29.2' },
    ]);
    await expect(service.getBuilds('quilt', '1.21.11')).resolves.toEqual(['0.30.1', '0.29.2']);
  });

  it('Vanilla has no build tier — always [] without ever calling fetch', async () => {
    const builds = await service.getBuilds('vanilla', '1.21.4');
    expect(builds).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('Forge derives Minecraft versions from promotions_slim.json\'s "-recommended"/"-latest" keys', async () => {
    mockFetchOnce({ promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.4.0', '1.19.2-recommended': '43.2.0' } });
    const versions = await service.getVersions('forge');
    expect(versions).toEqual(['1.20.1', '1.19.2']);
  });

  it('Forge build lookup returns recommended and latest for the chosen Minecraft version, deduplicated', async () => {
    mockFetchOnce({ promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.0' } });
    const builds = await service.getBuilds('forge', '1.20.1');
    expect(builds).toEqual(['47.3.0']);
  });

  it('NeoForge versions are derived from release-version prefixes and displayed with a leading "1."', async () => {
    mockFetchOnce({ versions: ['20.4.80', '20.4.79', '21.1.0'] });
    const versions = await service.getVersions('neoforge');
    expect(versions).toEqual(['1.21.1', '1.20.4']);
  });
});
