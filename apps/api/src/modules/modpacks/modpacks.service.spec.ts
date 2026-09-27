import { ModpacksService } from './modpacks.service';
import { CurseForgeProvider } from '../plugins/curseforge.provider';

describe('ModpacksService uninstall', () => {
  const actor = { id: 'user-1', isAdmin: false };
  const server = { id: 'server-1', nodeId: 'node-1' };
  const access = {
    resolve: jest.fn(async () => ({ server, role: 'owner', can: () => true })),
  };
  const agent = {
    getServerStatus: jest.fn(async () => ({ state: 'offline' })),
    restoreBackup: jest.fn(async () => undefined),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const activity = { record: jest.fn(async () => undefined) };
  const modrinth = { source: 'modrinth' };
  const curseforge = { source: 'curseforge' };

  beforeEach(() => jest.clearAllMocks());

  function createService(latest: Record<string, unknown> | null) {
    const installation = {
      findFirst: jest.fn(async () => latest),
      update: jest.fn(async () => latest),
    };
    const tx = { modpackInstallation: installation };
    const prisma = {
      withRLS: jest.fn(async (_scope: unknown, operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    };
    const service = new ModpacksService(
      access as never,
      prisma as never,
      agent as never,
      audit as never,
      activity as never,
      modrinth as never,
      curseforge as never,
    );
    return { service, installation };
  }

  it('treats a repeated removal of the latest uninstalled modpack as success', async () => {
    const { service, installation } = createService({
      id: 'install-2',
      serverId: server.id,
      status: 'uninstalled',
      backupId: 'backup-2',
    });

    await expect(service.uninstallLatest(actor, server.id)).resolves.toBeUndefined();

    expect(installation.findFirst).toHaveBeenCalledWith({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(agent.getServerStatus).not.toHaveBeenCalled();
    expect(agent.restoreBackup).not.toHaveBeenCalled();
    expect(installation.update).not.toHaveBeenCalled();
  });

  it('restores and marks the newest completed installation as uninstalled', async () => {
    const latest = {
      id: 'install-2',
      serverId: server.id,
      status: 'completed',
      backupId: 'backup-2',
      projectName: 'OreSpawn Adventure',
    };
    const { service, installation } = createService(latest);

    await service.uninstallLatest(actor, server.id);

    expect(agent.restoreBackup).toHaveBeenCalledWith(server.nodeId, server.id, latest.backupId);
    expect(installation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: latest.id },
      data: expect.objectContaining({ status: 'uninstalled' }),
    }));
  });
});

describe('ModpacksService latestInstallation manual-file resolution', () => {
  const actor = { id: 'user-1', isAdmin: false };
  const server = { id: 'server-1', nodeId: 'node-1', template: { softwareKind: 'forge' } };
  const access = { resolve: jest.fn(async () => ({ server, role: 'owner', can: () => true })) };
  const audit = { record: jest.fn(async () => undefined) };
  const activity = { record: jest.fn(async () => undefined) };
  const modrinth = { source: 'modrinth' };
  const curseforge = { source: 'curseforge' };

  beforeEach(() => jest.clearAllMocks());

  function createService(installationRow: Record<string, unknown> | null, listFiles: jest.Mock) {
    const installation = {
      findFirst: jest.fn(async () => installationRow),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ ...installationRow, ...args.data })),
    };
    const tx = { modpackInstallation: installation };
    const prisma = { withRLS: jest.fn(async (_scope: unknown, op: (client: typeof tx) => Promise<unknown>) => op(tx)) };
    const agent = { listFiles };
    const service = new ModpacksService(
      access as never, prisma as never, agent as never, audit as never, activity as never, modrinth as never, curseforge as never,
    );
    return { service, installation };
  }

  const manualFiles = [
    { name: 'Shots Fired', filename: 'shotsfired-1.20.1-0.2.2.jar', pageUrl: 'https://x/shots' },
    { name: 'Bee Fix', filename: 'BeeFix-1.20-1.0.7.jar', pageUrl: 'https://x/bee' },
  ];

  it('drops a manual file from the list once it appears in the addon directory, and persists that', async () => {
    const listFiles = jest.fn(async () => [
      { name: 'shotsfired-1.20.1-0.2.2.jar', isDir: false, size: 100, mode: '0644', modTime: '2026-01-01' },
      { name: 'other.jar', isDir: false, size: 100, mode: '0644', modTime: '2026-01-01' },
    ]);
    const { service, installation } = createService({ id: 'op-1', status: 'completed', manualFiles }, listFiles);

    const result = await service.latestInstallation(actor, server.id);

    expect(listFiles).toHaveBeenCalledWith(server.nodeId, server.id, 'mods');
    expect((result as { manualFiles: unknown[] }).manualFiles).toEqual([manualFiles[1]]);
    expect(installation.update).toHaveBeenCalledWith({ where: { id: 'op-1' }, data: { manualFiles: [manualFiles[1]] } });
  });

  it('clears manualFiles entirely once every listed file is present', async () => {
    const listFiles = jest.fn(async () => manualFiles.map((f) => ({ name: f.filename, isDir: false, size: 1, mode: '0644', modTime: '2026-01-01' })));
    const { service, installation } = createService({ id: 'op-1', status: 'completed', manualFiles }, listFiles);

    const result = await service.latestInstallation(actor, server.id);

    expect((result as { manualFiles: unknown }).manualFiles).toBeNull();
    expect(installation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ manualFiles: expect.anything() }) }));
  });

  it('does not touch the row when nothing has changed, and skips the Agent call entirely once there is nothing left to check', async () => {
    const listFiles = jest.fn();
    const { service, installation } = createService({ id: 'op-1', status: 'completed', manualFiles: [] }, listFiles);

    await service.latestInstallation(actor, server.id);

    expect(listFiles).not.toHaveBeenCalled();
    expect(installation.update).not.toHaveBeenCalled();
  });

  it('leaves an active (non-completed) installation alone', async () => {
    const listFiles = jest.fn();
    const { service, installation } = createService({ id: 'op-1', status: 'installing', manualFiles }, listFiles);

    const result = await service.latestInstallation(actor, server.id);

    expect(listFiles).not.toHaveBeenCalled();
    expect(installation.update).not.toHaveBeenCalled();
    expect((result as { manualFiles: unknown[] }).manualFiles).toBe(manualFiles);
  });

  it('degrades gracefully when the Agent is unreachable, keeping the stale list', async () => {
    const listFiles = jest.fn(async () => { throw new Error('agent unreachable'); });
    const { service, installation } = createService({ id: 'op-1', status: 'completed', manualFiles }, listFiles);

    const result = await service.latestInstallation(actor, server.id);

    expect((result as { manualFiles: unknown[] }).manualFiles).toBe(manualFiles);
    expect(installation.update).not.toHaveBeenCalled();
  });
});

describe('ModpacksService CurseForge dependency-failure auto-retry', () => {
  const nodeId = 'node-1';
  const serverId = 'server-1';
  const agent = {
    getServerStatus: jest.fn(async () => ({ state: 'offline' })),
    installModpack: jest.fn(async () => ({ operationId: 'op-2', status: 'pending' })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const activity = { record: jest.fn(async () => undefined) };
  const modrinth = { source: 'modrinth' };
  const curseforge = new CurseForgeProvider({ remember: (_n: string, _i: unknown, _t: number, load: () => Promise<unknown>) => load() } as never, { get: () => 'test-key' } as never);

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  // Forge's own crash text (color codes and all) for a mod ("colorwheel")
  // that mandatorily depends on another ("oculus") without scoping that
  // dependency to the client.
  const failedOperation = {
    id: 'op-1',
    serverId,
    nodeId,
    requestedBy: 'user-1',
    source: 'curseforge',
    projectId: '490660',
    versionId: '8448903',
    projectName: 'DeceasedCraft',
    versionName: 'DeceasedCraft_Beta_DH_Edition-5.10.17',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    status: 'failed',
    errorMessage: 'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [\nMod §ecolorwheel§r requires §6oculus§r §o1.7.0 or above§r',
    retryCount: 0,
    extraSkipProjectIds: null,
    skippedProjectIds: [581495],
    fileSlugs: { 581495: 'oculus', 1254143: 'colorwheel' },
  };

  function createService(operation: Record<string, unknown>) {
    const installation = {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => operation),
      findFirst: jest.fn(async () => null), // no other active install racing the retry
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'op-2', ...args.data })),
    };
    const server = {
      findFirst: jest.fn(async () => ({ id: serverId })), // reportProgress's node-ownership guard
      findUniqueOrThrow: jest.fn(async () => ({ nodeId, diskMb: 6144 })),
    };
    const tx = { modpackInstallation: installation, server, $executeRaw: jest.fn(async () => undefined) };
    const prisma = { withRLS: jest.fn(async (_scope: unknown, op: (client: typeof tx) => Promise<unknown>) => op(tx)) };
    const service = new ModpacksService(
      {} as never, prisma as never, agent as never, audit as never, activity as never, modrinth as never, curseforge as never,
    );
    return { service, installation, server };
  }

  it('retries once more, skipping the mod that depended on something already skipped', async () => {
    jest.spyOn(curseforge, 'getVersion').mockResolvedValue({
      source: 'curseforge', versionId: '8448903', projectId: '490660', name: 'v', versionNumber: 'v', minecraftVersions: ['1.20.1'], loaders: ['forge'],
      releaseType: 'release', publishedAt: '2026-01-01T00:00:00Z', downloads: 0,
      files: [{ filename: 'pack.zip', size: 100, primary: true, url: 'https://edge.forgecdn.net/files/8/9/pack.zip', hashes: { sha1: 'abc' } }],
    });
    const { service, installation } = createService(failedOperation);

    await service.reportProgress(nodeId, serverId, { operationId: 'op-1', status: 'failed', progress: 100, message: 'Falha', errorMessage: failedOperation.errorMessage });

    expect(agent.installModpack).toHaveBeenCalledTimes(1);
    const created = installation.create.mock.calls[0][0].data;
    expect(created.extraSkipProjectIds).toEqual([1254143]); // colorwheel's projectId, not oculus's
    expect(created.retryCount).toBe(1);
    expect(created.retriedFromId).toBe('op-1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.modpack.install.retry' }));
  });

  it('does not retry once MAX_AUTO_RETRIES is reached', async () => {
    const { service, installation } = createService({ ...failedOperation, retryCount: 3 });

    await service.reportProgress(nodeId, serverId, { operationId: 'op-1', status: 'failed', progress: 100, message: 'Falha', errorMessage: failedOperation.errorMessage });

    expect(agent.installModpack).not.toHaveBeenCalled();
    expect(installation.create).not.toHaveBeenCalled();
  });

  it('does not retry when the missing dependency is unrelated to anything we skipped', async () => {
    const { service, installation } = createService({
      ...failedOperation,
      errorMessage: 'Mod §esomemod§r requires §6unrelated§r §o1.0.0 or above§r',
      fileSlugs: { 1254143: 'colorwheel', 99: 'somemod', 100: 'unrelated' },
      skippedProjectIds: [], // "unrelated" was never something we chose to skip
    });

    await service.reportProgress(nodeId, serverId, { operationId: 'op-1', status: 'failed', progress: 100, message: 'Falha', errorMessage: 'irrelevant here' });

    expect(agent.installModpack).not.toHaveBeenCalled();
    expect(installation.create).not.toHaveBeenCalled();
  });

  it('does not retry a boot failure unrelated to any missing dependency', async () => {
    const { service, installation } = createService({ ...failedOperation, errorMessage: 'java.lang.OutOfMemoryError: Java heap space' });

    await service.reportProgress(nodeId, serverId, { operationId: 'op-1', status: 'failed', progress: 100, message: 'Falha', errorMessage: 'irrelevant here' });

    expect(agent.installModpack).not.toHaveBeenCalled();
    expect(installation.create).not.toHaveBeenCalled();
  });
});
