import { deriveHealthStatus } from './nodes.service';

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
