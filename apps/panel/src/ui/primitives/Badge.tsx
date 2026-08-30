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
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}
