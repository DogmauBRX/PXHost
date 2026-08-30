import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type Tone = 'accent' | 'ok' | 'warn' | 'fail' | 'info';

const iconTone: Record<Tone, string> = {
  accent: 'bg-accent-tint text-accent-strong',
  ok: 'bg-ok-tint text-ok',
  warn: 'bg-warn-tint text-warn',
  fail: 'bg-fail-tint text-fail',
  info: 'bg-info-tint text-info',
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  hint?: ReactNode;
  loading?: boolean;
}

export function StatCard({ label, value, icon: Icon, tone = 'accent', hint, loading }: StatCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-text-muted">{label}</p>
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconTone[tone]}`}>
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-text tabular-nums">
        {loading ? <span className="inline-block h-8 w-16 animate-pulse rounded bg-surface-2 align-middle" /> : value}
      </p>
      {hint && <p className="mt-1.5 text-xs text-text-faint">{hint}</p>}
    </div>
  );
}
