import {
  ceilingFor,
  capacityStatus,
  DEFAULT_CAPACITY_THRESHOLDS,
  resolveNodeCapacity,
  slotsForPlanOnNode,
  nodeAcceptsNewServers,
  type NodeCapacityConfig,
  type NodeAcceptanceInputs,
} from './capacity.math';

// No unit spec existed for this module before — capacity.math.ts is
// pure by design specifically so it can be tested with plain fixtures
// (see its own doc comment), and this is the first time that's
// actually exercised.

describe('ceilingFor (regression — resolveNodeCapacity must never change this function\'s own behavior)', () => {
  it('unlimited overallocate returns null regardless of total', () => {
    expect(ceilingFor(1000, 0, -1)).toBeNull();
  });
  it('unconfigured total (<=0) returns null (never a ceiling of 0)', () => {
    expect(ceilingFor(0, 0, 0)).toBeNull();
  });
  it('floors the ceiling exactly once', () => {
    expect(ceilingFor(1000, 0, 33)).toBe(Math.floor(1000 * 1.33));
  });
});

function nodeConfig(overrides: Partial<NodeCapacityConfig> = {}): NodeCapacityConfig {
  return {
    memoryTotalMb: 8000,
    memoryReservedMb: 0,
    memoryOverallocatePct: 0,
    diskTotalMb: 100_000,
    diskReservedMb: 0,
    diskOverallocatePct: 0,
    cpuTotalPercent: 0,
    cpuReservedPercent: 0,
    cpuOverallocatePct: -1,
    capacityMode: 'manual',
    memorySafetyMarginPct: 10,
    diskSafetyMarginPct: 10,
    cpuSafetyMarginPct: 10,
    reportedMemoryLimitMb: null,
    reportedMemoryTotalMb: null,
    reportedDiskTotalMb: null,
    reportedCpuCount: null,
    reportedAt: null,
    ...overrides,
  };
}

describe('resolveNodeCapacity', () => {
  it('manual mode: declared columns pass through unchanged, reserved is the admin reserve alone', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ memoryTotalMb: 8000, memoryReservedMb: 500, reportedMemoryTotalMb: 999_999 }));
    expect(resolved.memoryTotalMb).toBe(8000);
    expect(resolved.memoryReservedMb).toBe(500);
    expect(resolved.memory.provenance).toBe('manual');
    expect(resolved.memory.safetyMarginPct).toBe(0);
    expect(resolved.telemetryStale).toBe(false); // staleness is an auto-mode-only concept
  });

  it('auto mode with telemetry: effective total is detected, reserved is margin + admin reserve, stacked not replaced', () => {
    const resolved = resolveNodeCapacity(
      nodeConfig({
        capacityMode: 'auto',
        memoryReservedMb: 200, // admin reserve, on top of the margin
        memorySafetyMarginPct: 10,
        reportedMemoryTotalMb: 32_000,
        reportedAt: new Date(),
      }),
    );
    expect(resolved.memory.provenance).toBe('auto');
    expect(resolved.memory.detected).toBe(32_000);
    expect(resolved.memoryTotalMb).toBe(32_000); // effectiveTotal
    expect(resolved.memoryReservedMb).toBe(Math.round(32_000 * 0.1) + 200); // 3200 + 200
    expect(resolved.telemetryStale).toBe(false);
  });

  it('auto mode prefers the cgroup memory LIMIT over the host-wide MemTotal (the LXC/Proxmox fix)', () => {
    const resolved = resolveNodeCapacity(
      nodeConfig({ capacityMode: 'auto', reportedMemoryTotalMb: 192_000, reportedMemoryLimitMb: 32_000, reportedAt: new Date() }),
    );
    expect(resolved.memory.detected).toBe(32_000);
    expect(resolved.memoryTotalMb).toBe(32_000);
  });

  it('auto mode falls back to reportedMemoryTotalMb when no cgroup limit was ever reported (older agent, or genuinely unlimited cgroup)', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ capacityMode: 'auto', reportedMemoryTotalMb: 32_000, reportedMemoryLimitMb: null, reportedAt: new Date() }));
    expect(resolved.memory.detected).toBe(32_000);
  });

  it('auto mode with NO telemetry for a dimension: provenance is "unconfigured", never falls back to unlimited', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ capacityMode: 'auto', memoryTotalMb: 0, reportedMemoryTotalMb: null }));
    expect(resolved.memory.provenance).toBe('unconfigured');
    expect(resolved.memoryTotalMb).toBe(0); // falls back to the declared column, not Infinity
  });

  it('CPU: reportedCpuCount is converted to percent-of-a-core the same way deriveTelemetryDivergence does (count * 100)', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ capacityMode: 'auto', reportedCpuCount: 8, reportedAt: new Date() }));
    expect(resolved.cpu.detected).toBe(800);
    expect(resolved.cpuTotalPercent).toBe(800);
  });

  it('telemetryStale is true in auto mode when reportedAt is null', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ capacityMode: 'auto', reportedMemoryTotalMb: 8000, reportedAt: null }));
    expect(resolved.telemetryStale).toBe(true);
  });

  it('telemetryStale is true in auto mode when reportedAt is older than TELEMETRY_STALE_MS', () => {
    const resolved = resolveNodeCapacity(nodeConfig({ capacityMode: 'auto', reportedMemoryTotalMb: 8000, reportedAt: new Date(Date.now() - 10 * 60_000) }));
    expect(resolved.telemetryStale).toBe(true);
  });
});

describe('slotsForPlanOnNode', () => {
  const node = {
    memoryTotalMb: 10_000,
    memoryReservedMb: 0,
    memoryOverallocatePct: 0,
    diskTotalMb: 100_000,
    diskReservedMb: 0,
    diskOverallocatePct: 0,
    cpuTotalPercent: 800,
    cpuReservedPercent: 0,
    cpuOverallocatePct: 0,
  };

  it('returns the MINIMUM across dimensions and names the limiting one (memory, from the plan §6 worked example)', () => {
    // 10000 RAM / 2 per plan = 5; 800 CPU / 200 per plan = 4; 100000 disk / 5 = 20000 — CPU is tightest here
    const result = slotsForPlanOnNode(node, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 5000, cpuPercent: 200 });
    expect(result).toEqual({ slots: 4, limiting: 'cpu' });
  });

  it('ignores a dimension the plan does not consume (requested <= 0)', () => {
    const result = slotsForPlanOnNode(node, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 5000, cpuPercent: 0 });
    // cpu ignored (requested 0) -> memory (5) vs disk (20000) -> memory wins
    expect(result).toEqual({ slots: 5, limiting: 'memory' });
  });

  it('ignores an unlimited dimension (overallocatePct -1)', () => {
    const unlimitedCpu = { ...node, cpuOverallocatePct: -1 };
    const result = slotsForPlanOnNode(unlimitedCpu, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 5000, cpuPercent: 200 });
    expect(result).toEqual({ slots: 5, limiting: 'memory' });
  });

  it('ignores CPU when accounting is off (total <= 0)', () => {
    const accountingOff = { ...node, cpuTotalPercent: 0, cpuOverallocatePct: -1 };
    const result = slotsForPlanOnNode(accountingOff, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 5000, cpuPercent: 9999 });
    expect(result).toEqual({ slots: 5, limiting: 'memory' });
  });

  it('a plan bigger than the node\'s remaining headroom floors to 0, not negative', () => {
    const result = slotsForPlanOnNode(node, { memoryMb: 9000, diskMb: 0, cpuPercent: 0 }, { memoryMb: 5000, diskMb: 0, cpuPercent: 0 });
    expect(result).toEqual({ slots: 0, limiting: 'memory' });
  });

  it('accounts for already-used capacity, not just the raw ceiling', () => {
    const result = slotsForPlanOnNode(node, { memoryMb: 6000, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 0, cpuPercent: 0 });
    expect(result).toEqual({ slots: 2, limiting: 'memory' }); // (10000-6000)/2000 = 2
  });

  it('every consumed dimension unlimited/off returns null slots (unlimited), not 0', () => {
    const allUnlimited = { ...node, memoryOverallocatePct: -1, diskOverallocatePct: -1, cpuTotalPercent: 0 };
    const result = slotsForPlanOnNode(allUnlimited, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }, { memoryMb: 2000, diskMb: 5000, cpuPercent: 200 });
    expect(result).toEqual({ slots: null, limiting: null });
  });
});

describe('capacityStatus', () => {
  it('4 levels against the default 70/85/95 thresholds', () => {
    expect(capacityStatus(0)).toBe('normal');
    expect(capacityStatus(69)).toBe('normal');
    expect(capacityStatus(70)).toBe('warning');
    expect(capacityStatus(84)).toBe('warning');
    expect(capacityStatus(85)).toBe('high');
    expect(capacityStatus(94)).toBe('high');
    expect(capacityStatus(95)).toBe('critical');
    expect(capacityStatus(150)).toBe('critical');
  });

  it('honors custom per-node thresholds', () => {
    expect(capacityStatus(50, { warnPct: 40, highPct: 60, criticalPct: 80 })).toBe('warning');
    expect(capacityStatus(50, DEFAULT_CAPACITY_THRESHOLDS)).toBe('normal');
  });
});

function acceptance(overrides: Partial<NodeAcceptanceInputs> = {}): NodeAcceptanceInputs {
  return {
    capacityMode: 'manual',
    maintenanceMode: false,
    health: 'unknown',
    memory: { detected: null, declared: 0, effectiveTotal: 0, safetyMarginPct: 0, adminReserve: 0, reserved: 0, provenance: 'manual' },
    disk: { detected: null, declared: 0, effectiveTotal: 0, safetyMarginPct: 0, adminReserve: 0, reserved: 0, provenance: 'manual' },
    telemetryStale: false,
    ...overrides,
  };
}

describe('nodeAcceptsNewServers', () => {
  it('manual mode: only maintenanceMode gates it — the exact behavior every node has today, even with no telemetry at all (dev/test)', () => {
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'manual', health: 'unknown' }))).toEqual({ ok: true });
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'manual', maintenanceMode: true }))).toEqual({ ok: false, reason: 'Node is in maintenance mode' });
  });

  it('auto mode refuses when offline or degraded', () => {
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'auto', health: 'offline' })).ok).toBe(false);
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'auto', health: 'degraded' })).ok).toBe(false);
  });

  it('auto mode refuses when memory or disk telemetry was never received ("unconfigured", never falls back to unlimited)', () => {
    const result = nodeAcceptsNewServers(
      acceptance({ capacityMode: 'auto', health: 'online', memory: { ...acceptance().memory, provenance: 'unconfigured' } }),
    );
    expect(result.ok).toBe(false);
  });

  it('auto mode refuses when telemetry is stale', () => {
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'auto', health: 'online', telemetryStale: true })).ok).toBe(false);
  });

  it('auto mode accepts with fresh, healthy, configured telemetry', () => {
    const configured = { detected: 8000, declared: 8000, effectiveTotal: 8000, safetyMarginPct: 10, adminReserve: 0, reserved: 800, provenance: 'auto' as const };
    expect(nodeAcceptsNewServers(acceptance({ capacityMode: 'auto', health: 'online', memory: configured, disk: configured }))).toEqual({ ok: true });
  });
});
