import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DiagnosticsService, PROBE_TARGETS, clockCheck, heartbeatCheck, labelFor, worstStatus } from './diagnostics.service';

function build(overrides: { agent?: jest.Mock; selectNode?: jest.Mock } = {}) {
  const now = new Date();
  const tx = {
    node: {
      findMany: jest.fn(async () => [
        { id: 'n1', name: 'node01-r620', maintenanceMode: false, lastHeartbeatAt: now },
        { id: 'n2', name: 'node02-dualxeon', maintenanceMode: false, lastHeartbeatAt: now },
      ]),
    },
    plan: {
      findMany: jest.fn(async () => [
        { id: 'p1', name: 'Básico', slug: 'basico' },
        { id: 'p2', name: 'Avançado', slug: 'avancado' },
      ]),
    },
    allocation: { findMany: jest.fn(async ({ where }: { where: { nodeId: string } }) => (where.nodeId === 'n1' ? [{ ip: '192.168.1.100' }] : [{ ip: '192.168.1.111' }])) },
    serverTemplate: { findFirst: jest.fn(async () => ({ dockerImages: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21' } })) },
  };
  const prisma = { withRLS: jest.fn((_ctx: unknown, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const agentDiagnostics =
    overrides.agent ??
    jest.fn(async () => ({
      agentTime: new Date().toISOString(),
      checks: [
        { key: 'docker', ok: true, detail: 'Docker 29.8.0', durationMs: 3 },
        { key: 'egress:piston-data.mojang.com', ok: true, detail: 'DNS e HTTPS ok (HTTP 404)', durationMs: 900 },
      ],
    }));
  const selectNode =
    overrides.selectNode ??
    jest.fn(async (planId: string) =>
      planId === 'p1'
        ? { selected: { nodeId: 'n1', name: 'node01-r620', score: 1 }, candidates: [] }
        : {
            selected: null,
            candidates: [
              { nodeId: 'n1', name: 'node01-r620', eliminated: true, reason: 'Plano não permitido neste node' },
              { nodeId: 'n2', name: 'node02-dualxeon', eliminated: true, reason: 'Plano não permitido neste node' },
            ],
          },
    );
  const service = new DiagnosticsService(prisma as never, { diagnostics: agentDiagnostics } as never, { selectNode } as never);
  return { service, agentDiagnostics, selectNode };
}

describe('DiagnosticsService', () => {
  it('flags a public plan that no node will accept, with every node’s reason', async () => {
    const { service } = build();
    const result = await service.run();
    const basico = result.plans.find((p) => p.slug === 'basico')!;
    const avancado = result.plans.find((p) => p.slug === 'avancado')!;
    expect(basico).toMatchObject({ status: 'ok', detail: 'novas compras vão para node01-r620' });
    expect(avancado.status).toBe('fail');
    expect(avancado.detail).toContain('node01-r620: Plano não permitido neste node');
    expect(avancado.detail).toContain('node02-dualxeon: Plano não permitido neste node');
    expect(result.status).toBe('fail');
  });

  it('sends the node’s allocation IPs, the probe targets and a Paper runtime image to the agent', async () => {
    const { service, agentDiagnostics } = build();
    await service.run();
    expect(agentDiagnostics).toHaveBeenCalledWith('n1', { image: 'ghcr.io/pterodactyl/yolks:java_21', targets: PROBE_TARGETS, ips: ['192.168.1.100'] });
    expect(agentDiagnostics).toHaveBeenCalledWith('n2', expect.objectContaining({ ips: ['192.168.1.111'] }));
  });

  it('maps agent checks to labelled results and keeps a healthy node ok', async () => {
    const { service } = build({ selectNode: jest.fn(async () => ({ selected: { nodeId: 'n1', name: 'node01-r620', score: 1 }, candidates: [] })) });
    const result = await service.run();
    const node = result.nodes[0];
    expect(node.status).toBe('ok');
    expect(node.checks.map((c) => c.label)).toEqual(['Heartbeat do agente', 'Relógio do node', 'Docker', 'Internet do container → piston-data.mojang.com']);
    expect(result.status).toBe('ok');
  });

  it('reports an unreachable agent as a failed node instead of failing the whole run', async () => {
    const agent = jest.fn(async (nodeId: string) => {
      if (nodeId === 'n2') throw new ServiceUnavailableException('Agent request failed: timeout');
      return { agentTime: new Date().toISOString(), checks: [] };
    });
    const { service } = build({ agent });
    const result = await service.run();
    const n2 = result.nodes.find((n) => n.nodeId === 'n2')!;
    expect(n2.status).toBe('fail');
    expect(n2.checks.at(-1)).toMatchObject({ key: 'agent', status: 'fail' });
    expect(result.nodes.find((n) => n.nodeId === 'n1')!.status).toBe('ok');
  });

  it('treats an agent without the diagnostics endpoint as outdated, not broken', async () => {
    const agent = jest.fn(async () => {
      throw new NotFoundException('Agent returned 404: 404 page not found');
    });
    const { service } = build({ agent });
    const result = await service.run();
    expect(result.nodes[0].checks.at(-1)).toMatchObject({ key: 'agent', status: 'warn' });
    expect(result.nodes[0].status).toBe('warn');
  });

  it('fails the node when any agent check fails', async () => {
    const agent = jest.fn(async () => ({
      agentTime: new Date().toISOString(),
      checks: [{ key: 'container_dns_config', ok: false, detail: 'servidores com DNS inutilizável', durationMs: 4 }],
    }));
    const { service } = build({ agent });
    const result = await service.run();
    expect(result.nodes[0].status).toBe('fail');
    expect(result.nodes[0].checks.at(-1)).toMatchObject({ label: 'DNS dos servidores existentes', status: 'fail' });
  });
});

describe('diagnostics helpers', () => {
  it('derives heartbeat status from age', () => {
    expect(heartbeatCheck(new Date()).status).toBe('ok');
    expect(heartbeatCheck(null).status).toBe('fail');
    expect(heartbeatCheck(new Date(Date.now() - 24 * 3600_000)).status).toBe('fail');
  });

  it('warns on a skewed node clock', () => {
    const now = Date.now();
    expect(clockCheck(new Date(now + 5_000).toISOString(), now).status).toBe('ok');
    expect(clockCheck(new Date(now - 5 * 60_000).toISOString(), now).status).toBe('warn');
    expect(clockCheck('garbage', now).status).toBe('warn');
  });

  it('labels and ranks', () => {
    expect(labelFor('egress:api.modrinth.com')).toBe('Internet do container → api.modrinth.com');
    expect(labelFor('allocation_ips')).toBe('IPs das allocations');
    expect(worstStatus(['ok', 'warn'])).toBe('warn');
    expect(worstStatus(['warn', 'fail', 'ok'])).toBe('fail');
    expect(worstStatus([])).toBe('ok');
  });
});
