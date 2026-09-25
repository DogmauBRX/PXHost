import { GatewayService } from './gateway.service';

describe('GatewayService reconciliation', () => {
  it('pushes an empty desired set when the database has no routes', async () => {
    const gateway = {
      id: 'gateway-1',
      name: 'Primary gateway',
      publicHost: '203.0.113.10',
      tunnelIp: '10.10.0.1',
      controlUrl: 'http://10.10.0.1:9443',
      isActive: true,
      lastAppliedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const tx = {
      gateway: {
        findMany: jest.fn().mockResolvedValue([gateway]),
        update: jest.fn().mockResolvedValue(gateway),
      },
      publicRoute: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      withRLS: jest.fn(async (_context, callback) => callback(tx)),
    };
    const driver = { apply: jest.fn().mockResolvedValue(undefined) };
    const service = new GatewayService(
      prisma as never,
      { get: jest.fn() } as never,
      { record: jest.fn() } as never,
      driver,
      {
        canPublish: jest.fn(),
        isHostnameAvailable: jest.fn(),
        ensureAddressRecord: jest.fn(),
        ensureSrv: jest.fn(),
        removeAddressRecord: jest.fn(),
        removeSrv: jest.fn(),
      },
    );

    await service.reconcileOnce();

    expect(driver.apply).toHaveBeenCalledWith(gateway, []);
    expect(tx.gateway.update).toHaveBeenCalledWith({
      where: { id: gateway.id },
      data: { lastAppliedAt: expect.any(Date), lastError: null },
    });
  });
});
