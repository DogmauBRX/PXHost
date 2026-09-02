export type Severity = 'none' | 'warn' | 'critical';

// High thresholds only — never a "you're at 70%" nudge. Disk is
// deliberately absent: the agent's disk_bytes is always 0 (see
// ServerStatsSnapshot's doc comment), so there's nothing honest to alert on.
export const MEMORY_WARN = 0.9;
export const MEMORY_CRITICAL = 0.97;
export const CPU_WARN = 0.95;

// How many consecutive high samples are required before the advisory
// fires — a single spike (a GC pause, a world-save tick) must never
// trigger it. Polled snapshots refresh every 60s (useServerStats), so 2
// samples is ~2 minutes sustained; live WS frames arrive every 2s, so 5
// frames is ~10 seconds sustained — short enough to still feel responsive
// on the console page where the user is actively watching.
export const SUSTAINED_SAMPLES = 2;
export const SUSTAINED_FRAMES = 5;

const DISMISS_PREFIX = 'pxhost.advisory';
const DISMISS_TTL_MS: Record<Exclude<Severity, 'none'>, number> = {
  warn: 7 * 24 * 60 * 60 * 1000,
  critical: 24 * 60 * 60 * 1000,
};

export function memorySeverity(usedBytes: number | null, limitBytes: number | null): Severity {
  if (usedBytes == null || limitBytes == null || limitBytes <= 0) return 'none';
  const ratio = usedBytes / limitBytes;
  if (ratio >= MEMORY_CRITICAL) return 'critical';
  if (ratio >= MEMORY_WARN) return 'warn';
  return 'none';
}

export function cpuSeverity(percent: number | null, limitPercent: number | null): Severity {
  if (percent == null || limitPercent == null || limitPercent <= 0) return 'none';
  if (percent / limitPercent >= CPU_WARN) return 'warn';
  return 'none';
}

/** Memory takes precedence over CPU — at most one advisory shown at a time. */
export function combineSeverity(memory: Severity, cpu: Severity): Severity {
  if (memory === 'critical') return 'critical';
  if (memory === 'warn') return 'warn';
  return cpu;
}

function dismissKey(serverId: string, severity: Exclude<Severity, 'none'>): string {
  return `${DISMISS_PREFIX}.${serverId}.${severity}`;
}

/** localStorage, not a backend preference — this is a per-viewer UI nicety, not data worth a table+migration+RLS policy for one boolean. Cost: doesn't follow the user across devices. */
export function isDismissed(serverId: string, severity: Severity): boolean {
  if (severity === 'none') return true;
  try {
    const raw = localStorage.getItem(dismissKey(serverId, severity));
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_TTL_MS[severity];
  } catch {
    return false;
  }
}

export function dismiss(serverId: string, severity: Severity): void {
  if (severity === 'none') return;
  try {
    localStorage.setItem(dismissKey(serverId, severity), String(Date.now()));
  } catch {
    // Private mode / blocked storage — the alert just reappears next render, harmless.
  }
}
