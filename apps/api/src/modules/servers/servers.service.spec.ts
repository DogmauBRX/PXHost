import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ServersService } from './servers.service';

/**
 * `dispatchToAgent`'s failure handling in isolation — an e2e spec proving
 * this end to end would need a real fake HTTP agent replying 409
 * mid-request, so this unit test isolates the exact branch instead, the
 * same "avoid a live dependency for a pure branch of logic" reasoning
 * `capability-token.service.spec.ts` already documents for its own fake
 * Prisma.
 *
 * The 409 `SERVER_EXISTS` branch used to simply return, treating the
 * conflict as success and waiting for the agent's install-completed
 * callback. Found live that no callback ever comes: the agent's 409 path
 * returns before installing anything, so a setup RETRY on an
 * already-registered UUID left the server on "Preparando" indefinitely
 * (twelve hours, across two retries). It is now re-driven through
 * reinstall, which is the endpoint that re-runs an install on a server
 * the agent already knows.
 */
describe('ServersService.dispatchToAgent', () => {
  function makeService(createServer: jest.Mock, reinstallServer: jest.Mock = jest.fn(async () => ({ state: 'installing' }))) {
    const updateMock = jest.fn(async () => ({}));
    const prisma = {
      withRLS: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ server: { update: updateMock } })),
    };
    const agent = { createServer, reinstallServer };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new ServersService(prisma as any, agent as any, audit as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, updateMock, audit, reinstallServer };
  }

  const conflict = () =>
    new ConflictException('Agent returned 409: {"error":{"code":"SERVER_EXISTS","message":"srv-1 is already registered"}}');

  const payload = {
    uuid: 'srv-1',
    uid: 100001,
    image: 'ghcr.io/pxhost/yolks:java_21',
    startupTemplate: 'java -jar server.jar',
    declaredVariables: [],
    variables: {},
    limits: { cpuPercent: 100, memoryMb: 1024, swapMb: 0, diskMb: 5120, ioWeight: 500 },
    allocations: [],
    installImage: 'ghcr.io/pxhost/installers:debian',
    installEntrypoint: 'bash',
    installScript: '#!/bin/sh\n',
  };

  it('um 409 SERVER_EXISTS vira um reinstall — é ele que dispara o install e o callback', async () => {
    const createServer = jest.fn().mockRejectedValue(conflict());
    const { service, updateMock, audit, reinstallServer } = makeService(createServer);

    await expect(service.dispatchToAgent('srv-1', 'node-1', payload, { rethrow: true })).resolves.toBeUndefined();

    expect(reinstallServer).toHaveBeenCalledWith('node-1', 'srv-1', expect.objectContaining({
      image: payload.image,
      startupTemplate: payload.startupTemplate,
      installScript: payload.installScript,
    }));
    expect(updateMock).not.toHaveBeenCalled(); // o install-completed do reinstall é quem reconcilia
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.create.dispatch_rerouted_to_reinstall', targetId: 'srv-1' }));
  });

  // O reinstall carrega só o que uma troca de software muda: nunca
  // uid/limits/allocations, que o *srv.Server já registrado preserva.
  it('o payload do reinstall não leva uid, limites nem alocações', async () => {
    const createServer = jest.fn().mockRejectedValue(conflict());
    const { service, reinstallServer } = makeService(createServer);

    await service.dispatchToAgent('srv-1', 'node-1', payload);

    const enviado = reinstallServer.mock.calls[0][2];
    expect(enviado).not.toHaveProperty('uid');
    expect(enviado).not.toHaveProperty('limits');
    expect(enviado).not.toHaveProperty('allocations');
  });

  // O ponto da correção: nada pode sair daqui deixando a linha em
  // "installing" sem ninguém a caminho para reconciliá-la.
  it('se o reinstall também falhar, marca install_failed em vez de esperar para sempre', async () => {
    const createServer = jest.fn().mockRejectedValue(conflict());
    const reinstallServer = jest.fn().mockRejectedValue(new ServiceUnavailableException('agente fora do ar'));
    const { service, updateMock, audit } = makeService(createServer, reinstallServer);

    await expect(service.dispatchToAgent('srv-1', 'node-1', payload, { rethrow: true })).rejects.toThrow(ServiceUnavailableException);

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'srv-1' }, data: { status: 'install_failed' } }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.create.dispatch_failed', targetId: 'srv-1' }));
  });

  it('a genuine dispatch failure marks install_failed and rethrows when rethrow:true (the setup/retry path)', async () => {
    const createServer = jest.fn().mockRejectedValue(new ServiceUnavailableException('Agent request failed: connect ECONNREFUSED'));
    const { service, updateMock, audit } = makeService(createServer);

    await expect(service.dispatchToAgent('srv-2', 'node-1', payload, { rethrow: true })).rejects.toThrow(ServiceUnavailableException);

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'srv-2' }, data: { status: 'install_failed' } }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.create.dispatch_failed', targetId: 'srv-2' }));
  });

  it('a genuine dispatch failure marks install_failed but swallows the error when rethrow is omitted (the admin/legacy create path)', async () => {
    const createServer = jest.fn().mockRejectedValue(new ServiceUnavailableException('down'));
    const { service, updateMock } = makeService(createServer);

    await expect(service.dispatchToAgent('srv-3', 'node-1', payload)).resolves.toBeUndefined();
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'srv-3' }, data: { status: 'install_failed' } }));
  });

  it('a successful dispatch never touches the row or the audit log', async () => {
    const createServer = jest.fn().mockResolvedValue({ state: 'installing' });
    const { service, updateMock, audit } = makeService(createServer);

    await expect(service.dispatchToAgent('srv-4', 'node-1', payload, { rethrow: true })).resolves.toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
