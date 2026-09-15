import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ServersService } from './servers.service';

/**
 * `dispatchToAgent`'s failure handling in isolation — the setup plan's
 * own retry-safety proof (see ServerSetupService's doc comment) hinges
 * on 409 `SERVER_EXISTS` being absorbed as success rather than
 * misreported as a failure that would invite an unnecessary, actually-
 * redundant retry. An e2e spec proving this end to end would need a real
 * fake HTTP agent replying 409 mid-request — this unit test isolates the
 * exact branch instead, the same "avoid a live dependency for a pure
 * branch of logic" reasoning `capability-token.service.spec.ts` already
 * documents for its own fake Prisma.
 */
describe('ServersService.dispatchToAgent', () => {
  function makeService(createServer: jest.Mock) {
    const updateMock = jest.fn(async () => ({}));
    const prisma = {
      withRLS: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ server: { update: updateMock } })),
    };
    const agent = { createServer };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new ServersService(prisma as any, agent as any, audit as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, updateMock, audit };
  }

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

  it('treats a 409 SERVER_EXISTS as success — never marks install_failed, never throws even with rethrow:true', async () => {
    const createServer = jest.fn().mockRejectedValue(new ConflictException('Agent returned 409: {"error":{"code":"SERVER_EXISTS","message":"srv-1 is already registered"}}'));
    const { service, updateMock, audit } = makeService(createServer);

    await expect(service.dispatchToAgent('srv-1', 'node-1', payload, { rethrow: true })).resolves.toBeUndefined();

    expect(updateMock).not.toHaveBeenCalled(); // never overwritten to install_failed — the later install-completed callback is the sole authority now
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.create.dispatch_already_registered', targetId: 'srv-1' }));
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
