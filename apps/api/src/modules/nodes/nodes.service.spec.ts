import { deriveHealthStatus, deriveTelemetryDivergence } from './nodes.service';

describe('deriveHealthStatus', () => {
  it('is "unknown" when the node has never heartbeated', () => {
    expect(deriveHealthStatus(null)).toBe('unknown');
  });

  it('is "online" for a heartbeat within the last 45s', () => {
    expect(deriveHealthStatus(new Date(Date.now() - 10_000))).toBe('online');
  });

  it('is "online" right at the boundary just under 45s', () => {
    expect(deriveHealthStatus(new Date(Date.now() - 44_999))).toBe('online');
  });

  it('is "degraded" between 45s and 120s', () => {
    expect(deriveHealthStatus(new Date(Date.now() - 60_000))).toBe('degraded');
  });

  it('is "offline" beyond 120s', () => {
    expect(deriveHealthStatus(new Date(Date.now() - 200_000))).toBe('offline');
  });

  it('is "offline" for a heartbeat far in the past', () => {
    expect(deriveHealthStatus(new Date('2020-01-01'))).toBe('offline');
  });
});

describe('deriveTelemetryDivergence', () => {
  const base = { memoryTotalMb: 8192, reportedMemoryTotalMb: null, diskTotalMb: 51200, reportedDiskTotalMb: null, cpuTotalPercent: 0, reportedCpuCount: null };

  it('is "unknown" for every dimension when there is no telemetry at all — never a false "ok"', () => {
    expect(deriveTelemetryDivergence(base)).toEqual({ memory: 'unknown', disk: 'unknown', cpu: 'unknown' });
  });

  it('is "ok" when declared is below what the agent reports — the NORMAL case (agent runs on the Proxmox host, sees Proxmox + other VMs too)', () => {
    const result = deriveTelemetryDivergence({ ...base, reportedMemoryTotalMb: 32768, reportedDiskTotalMb: 500000 });
    expect(result.memory).toBe('ok');
    expect(result.disk).toBe('ok');
  });

  it('is "ok" when declared exactly equals reported — the boundary is inclusive', () => {
    const result = deriveTelemetryDivergence({ ...base, reportedMemoryTotalMb: 8192 });
    expect(result.memory).toBe('ok');
  });

  it('is "over" ONLY when declared exceeds what the agent actually has — the one dangerous direction', () => {
    const result = deriveTelemetryDivergence({ ...base, reportedMemoryTotalMb: 4096, reportedDiskTotalMb: 10000 });
    expect(result.memory).toBe('over');
    expect(result.disk).toBe('over');
  });

  it('cpu is "unknown" when accounting is off (cpuTotalPercent <= 0), regardless of what the agent reports — matches the nodes_cpu_accounting_check meaning of 0', () => {
    const result = deriveTelemetryDivergence({ ...base, cpuTotalPercent: 0, reportedCpuCount: 1 });
    expect(result.cpu).toBe('unknown');
  });

  it('cpu compares declared cores (cpuTotalPercent / 100) against reported core count', () => {
    const fits = deriveTelemetryDivergence({ ...base, cpuTotalPercent: 200, reportedCpuCount: 4 }); // 2 declared cores <= 4 real
    expect(fits.cpu).toBe('ok');
    const over = deriveTelemetryDivergence({ ...base, cpuTotalPercent: 800, reportedCpuCount: 4 }); // 8 declared cores > 4 real
    expect(over.cpu).toBe('over');
  });
});
