import { ServerSetupService } from './server-setup.service';

describe('ServerSetupService.reinstallCurrent', () => {
  it('reuses the current template and every current variable', async () => {
    const access = {
      resolve: jest.fn(async () => ({
        server: { id: 'server-1', name: 'Servidor', templateId: 'template-1', status: 'ready' },
        role: 'owner',
        can: () => true,
      })),
    };
    const tx = {
      serverVariable: {
        findMany: jest.fn(async () => [
          { value: '1.21.10', variable: { envVariable: 'MINECRAFT_VERSION' } },
          { value: '55.1.0', variable: { envVariable: 'FORGE_VERSION' } },
          { value: 'server.jar', variable: { envVariable: 'SERVER_JARFILE' } },
        ]),
      },
    };
    const prisma = { withRLS: jest.fn(async (_ctx, callback) => callback(tx)) };
    const service = new ServerSetupService(
      prisma as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const changeVersion = jest.spyOn(service, 'changeVersion').mockResolvedValue({ id: 'server-1', status: 'installing' });
    const actor = { id: 'user-1', isAdmin: false };

    await service.reinstallCurrent(actor, 'server-1');

    expect(prisma.withRLS).toHaveBeenCalledWith({ userId: 'user-1', isAdmin: false }, expect.any(Function));
    expect(tx.serverVariable.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', variable: { templateId: 'template-1' } },
      select: { value: true, variable: { select: { envVariable: true } } },
    });
    expect(changeVersion).toHaveBeenCalledWith(actor, 'server-1', {
      templateId: 'template-1',
      variables: {
        MINECRAFT_VERSION: '1.21.10',
        FORGE_VERSION: '55.1.0',
        SERVER_JARFILE: 'server.jar',
      },
    }, 'server.version.reinstalled');
  });

  it('uses the safe setup retry path after a failed installation', async () => {
    const access = {
      resolve: jest.fn(async () => ({
        server: { id: 'server-1', name: 'Servidor falho', templateId: 'template-1', status: 'install_failed' },
        role: 'owner',
        can: () => true,
      })),
    };
    const tx = {
      serverVariable: {
        findMany: jest.fn(async () => [
          { value: '1.21.10', variable: { envVariable: 'MINECRAFT_VERSION' } },
          { value: '55.1.0', variable: { envVariable: 'FORGE_VERSION' } },
        ]),
      },
    };
    const prisma = { withRLS: jest.fn(async (_ctx, callback) => callback(tx)) };
    const service = new ServerSetupService(
      prisma as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const complete = jest.spyOn(service, 'complete').mockResolvedValue({ id: 'server-1', status: 'installing' });
    const changeVersion = jest.spyOn(service, 'changeVersion');
    const actor = { id: 'user-1', isAdmin: false };

    await service.reinstallCurrent(actor, 'server-1');

    expect(complete).toHaveBeenCalledWith(actor, 'server-1', {
      name: 'Servidor falho',
      templateId: 'template-1',
      variables: { MINECRAFT_VERSION: '1.21.10', FORGE_VERSION: '55.1.0' },
    });
    expect(changeVersion).not.toHaveBeenCalled();
  });
});

describe('ServerSetupService.changeVersion power check', () => {
  function build(agentState: string) {
    const server = { id: 'server-1', nodeId: 'node-1', status: 'ready', powerState: 'running', templateId: 'template-1', dockerImage: 'img', startupCommand: 'java', memoryMb: 4096 };
    const access = { resolve: jest.fn(async () => ({ server, role: 'owner', can: () => true })) };
    const tx = {
      server: { updateMany: jest.fn(async () => ({ count: 1 })) },
      serverVariable: { upsert: jest.fn(async () => ({})) },
    };
    const prisma = {
      serverTemplate: { findFirst: jest.fn(async () => ({ id: 'template-1', softwareKind: 'paper', dockerImages: { 'Java 21': 'yolks:java_21' }, startupCommand: 'java -jar server.jar', installImage: '', installEntrypoint: '', installScript: 'echo' })) },
      templateVariable: { findMany: jest.fn(async () => []) },
      withRLS: jest.fn(async (_ctx: unknown, cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const servers = { dispatchReinstallToAgent: jest.fn(async () => undefined) };
    const audit = { record: jest.fn(async () => undefined) };
    const agent = { getServerStatus: jest.fn(async () => ({ state: agentState })) };
    const service = new ServerSetupService(prisma as never, access as never, {} as never, servers as never, audit as never, {} as never, agent as never);
    return { service, tx, servers };
  }
  const actor = { id: 'user-1', isAdmin: false };

  it('trusts the agent over a stale powerState right after a stop', async () => {
    const { service, tx, servers } = build('offline');
    await expect(service.changeVersion(actor, 'server-1', { templateId: 'template-1', variables: {} })).resolves.toEqual({ id: 'server-1', status: 'installing' });
    expect(tx.server.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'server-1', status: 'ready' } }));
    expect(servers.dispatchReinstallToAgent).toHaveBeenCalled();
  });

  it('treats a crashed server as stopped', async () => {
    const { service, servers } = build('crashed');
    await service.changeVersion(actor, 'server-1', { templateId: 'template-1', variables: {} });
    expect(servers.dispatchReinstallToAgent).toHaveBeenCalled();
  });

  it('refuses while the agent reports the server running', async () => {
    const { service, tx, servers } = build('running');
    await expect(service.changeVersion(actor, 'server-1', { templateId: 'template-1', variables: {} })).rejects.toThrow('SERVER_MUST_BE_OFFLINE');
    expect(tx.server.updateMany).not.toHaveBeenCalled();
    expect(servers.dispatchReinstallToAgent).not.toHaveBeenCalled();
  });
});
