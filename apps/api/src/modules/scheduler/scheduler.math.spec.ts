import { fitScore, headroomFor, rankCandidates } from './scheduler.math';
import type { NodeCapacityInputs, NodeUsage, ResourceRequest } from '../capacity/capacity.math';

function node(overrides: Partial<NodeCapacityInputs> = {}): NodeCapacityInputs {
  return {
    memoryTotalMb: 10_000,
    memoryReservedMb: 0,
    memoryOverallocatePct: 0,
    diskTotalMb: 100_000,
    diskReservedMb: 0,
    diskOverallocatePct: 0,
    cpuTotalPercent: 0, // accounting off by default — unlimited, matches every node's real-world default
    cpuReservedPercent: 0,
    cpuOverallocatePct: -1,
    ...overrides,
  };
}

const request: ResourceRequest = { memoryMb: 400, diskMb: 1000, cpuPercent: 100 };

describe('headroomFor', () => {
  it('is 1 (unlimited) when overallocatePct is -1, regardless of usage', () => {
    expect(headroomFor(1000, 0, -1, 999_999, 1)).toBe(1);
  });

  it('is 1 (unlimited) when total is unconfigured (<=0) — the CPU-off default', () => {
    expect(headroomFor(0, 0, 50, 0, 100)).toBe(1);
  });

  it('is the fraction of ceiling still free after the request', () => {
    // ceiling = (1000 - 0) * 1.0 = 1000; used 400, requesting 100 -> (1000-400-100)/1000
    expect(headroomFor(1000, 0, 0, 400, 100)).toBeCloseTo(0.5);
  });

  it('is -1 for the degenerate ceiling<=0 case (reserved capped at total)', () => {
    expect(headroomFor(1000, 1000, 0, 0, 1)).toBe(-1);
  });
});

describe('fitScore', () => {
  it("doesn't care about server count — a node with 20 small servers can outscore one with 8 big servers if it has more headroom", () => {
    // 20 STARTER servers (400MB each) = 8000MB used, vs 8 MODPACK servers
    // (1150MB each) = 9200MB used, both on a 10000MB node. Neither
    // `fitScore` nor `NodeCapacityInputs`/`NodeUsage` has any notion of
    // "how many servers" — this test proves the headroom-only design
    // actually produces the "more empty wins" outcome, not just that the
    // function signature happens to omit a count.
    const manySmall: NodeUsage = { memoryMb: 8_000, diskMb: 10_000, cpuPercent: 0 };
    const fewBig: NodeUsage = { memoryMb: 9_200, diskMb: 10_000, cpuPercent: 0 };

    const scoreManySmall = fitScore(node(), manySmall, request, 0, false);
    const scoreFewBig = fitScore(node(), fewBig, request, 0, false);

    expect(scoreManySmall).toBeGreaterThan(scoreFewBig);
  });

  it('priority nudges the score by at most ±0.20, never enough to override a clearly emptier node', () => {
    const empty: NodeUsage = { memoryMb: 0, diskMb: 0, cpuPercent: 0 };
    const nearlyFull: NodeUsage = { memoryMb: 9_500, diskMb: 0, cpuPercent: 0 };

    // The nearly-full node gets the maximum possible priority boost; the
    // empty node gets none. Priority still can't close a headroom gap
    // this large.
    const emptyScore = fitScore(node(), empty, request, 0, false);
    const nearlyFullScoreMaxPriority = fitScore(node(), nearlyFull, request, 100, false);
    expect(emptyScore).toBeGreaterThan(nearlyFullScoreMaxPriority);
  });

  it('penalizes unknown health by exactly 0.50', () => {
    const usage: NodeUsage = { memoryMb: 1_000, diskMb: 1_000, cpuPercent: 0 };
    const known = fitScore(node(), usage, request, 0, false);
    const unknown = fitScore(node(), usage, request, 0, true);
    expect(known - unknown).toBeCloseTo(0.5);
  });
});

describe('rankCandidates', () => {
  it('sorts by score, then priority, then free memory, then node id — deterministically', () => {
    const candidates = [
      { nodeId: 'b', score: 1, priority: 0, memoryFreeMb: 100 },
      { nodeId: 'a', score: 1, priority: 0, memoryFreeMb: 100 }, // exact tie with 'b' down to id
      { nodeId: 'c', score: 2, priority: 0, memoryFreeMb: 0 }, // highest score wins outright
      { nodeId: 'd', score: 1, priority: 5, memoryFreeMb: 0 }, // ties score with a/b, wins on priority
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked.map((c) => c.nodeId)).toEqual(['c', 'd', 'a', 'b']);
  });
});
