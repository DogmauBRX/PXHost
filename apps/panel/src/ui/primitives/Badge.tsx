import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'fail' | 'neutral';

const toneClasses: Record<Tone, string> = {
  ok: 'text-ok bg-ok-tint',
  warn: 'text-warn bg-warn-tint',
  fail: 'text-fail bg-fail-tint',
  neutral: 'text-text-muted bg-surface-2',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[0.68rem] uppercase tracking-wide ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  ready: 'ok',
  running: 'ok',
  installing: 'warn',
  starting: 'warn',
  stopping: 'warn',
  install_failed: 'fail',
  offline: 'neutral',
  crashed: 'fail',
  suspended: 'fail',
  setup_pending: 'warn',
};

/**
 * `label` is an optional override — pass `serverStatusLabel(status)`
 * (features/servers/status-labels.ts) for a pt-BR label; omitted, this
 * falls back to the raw status with underscores turned to spaces, same
 * as before that helper existed. Kept optional (not required) so this
 * primitives-layer component never has to import domain vocabulary
 * itself, and every existing call site keeps compiling untouched.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label ?? status.replace(/_/g, ' ')}</Badge>;
}
