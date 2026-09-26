import { ServerSetupService } from './server-setup.service';

describe('ServerSetupService.reinstallCurrent', () => {
  it('reuses the current template and every current variable', async () => {
    const access = {
      resolve: jest.fn(async () => ({
        server: { id: 'server-1', templateId: 'template-1' },
        role: 'owner',
        can: () => true,
      })),
    };
    const prisma = {
      serverVariable: {
        findMany: jest.fn(async () => [
          { value: '1.21.10', variable: { envVariable: 'MINECRAFT_VERSION' } },
          { value: '55.1.0', variable: { envVariable: 'FORGE_VERSION' } },
          { value: 'server.jar', variable: { envVariable: 'SERVER_JARFILE' } },
        ]),
      },
    };
    const service = new ServerSetupService(
      prisma as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const changeVersion = jest.spyOn(service, 'changeVersion').mockResolvedValue({ id: 'server-1', status: 'installing' });
    const actor = { id: 'user-1', isAdmin: false };

    await service.reinstallCurrent(actor, 'server-1');

    expect(prisma.serverVariable.findMany).toHaveBeenCalledWith({
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
});
