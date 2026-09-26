import { ModpacksService } from './modpacks.service';

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
