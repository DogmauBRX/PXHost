import { CanaryService } from './canary.service';

function build(opts: { running?: { id: string; startedAt: Date } | null; nodes?: unknown[]; leftovers?: Array<{ id: string; name: string }> } = {}) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const tx = {
    canaryRun: {
      findFirst: jest.fn(async () => opts.running ?? null),
      create: jest.fn(async () => ({ id: 'run-1' })),
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return args;
      }),
    },
    user: {
      findFirst: jest.fn(async () => ({ id: 'admin-1' })),
      findMany: jest.fn(async () => [{ email: 'root@gxhost.com.br' }]),
    },
    server: { findMany: jest.fn(async () => opts.leftovers ?? []) },
    node: { findMany: jest.fn(async () => opts.nodes ?? []) },
    plan: { findMany: jest.fn(async () => []) },
    serverTemplate: { findMany: jest.fn(async () => [{ id: 't-paper', softwareKind: 'paper' }]) },
  };
  const prisma = { withRLS: jest.fn((_c: unknown, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const mail = { sendAdminAlert: jest.fn(async () => undefined) };
  const servers = { remove: jest.fn(async () => undefined) };
  const diagnostics = { run: jest.fn(async () => ({ status: 'ok', plans: [], nodes: [], ranAt: '' })) };
  const config = { get: jest.fn(() => 'https://gxhost.com.br') };
  const service = new CanaryService(
    prisma as never,
    config as never,
    mail as never,
    servers as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    diagnostics as never,
  );
  return { service, tx, updates, mail, servers };
}

describe('CanaryService.run', () => {
  it('does not start a second run while one is in progress', async () => {
    const { service, tx } = build({ running: { id: 'old', startedAt: new Date() } });
    await expect(service.run('manual')).resolves.toBeNull();
    expect(tx.canaryRun.create).not.toHaveBeenCalled();
  });

  it('closes a run abandoned by a worker restart before starting a new one', async () => {
    const { service, updates } = build({ running: { id: 'old', startedAt: new Date(Date.now() - 4 * 3600_000) } });
    await service.run('schedule');
    expect(updates[0]).toMatchObject({ where: { id: 'old' }, data: { status: 'failed' } });
  });

  it('removes servers left behind by a previous run', async () => {
    const { service, servers } = build({ leftovers: [{ id: 's1', name: 'canary-paper-2026-10-04' }] });
    await service.run('schedule');
    expect(servers.remove).toHaveBeenCalledWith('s1');
  });

  it('fails and alerts the admins when no node can receive the tests', async () => {
    const { service, updates, mail } = build({ nodes: [] });
    await service.run('schedule');
    const final = updates.at(-1)!;
    expect(final.data.status).toBe('failed');
    expect(String(final.data.summary)).toContain('nenhum node online');
    expect(mail.sendAdminAlert).toHaveBeenCalledWith('root@gxhost.com.br', expect.stringContaining('Canário com falha'), expect.any(String));
  });
});
