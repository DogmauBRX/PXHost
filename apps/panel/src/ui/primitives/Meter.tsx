type Tone = 'normal' | 'warning' | 'critical';

const barTone: Record<Tone, string> = {
  normal: 'bg-ok',
  warning: 'bg-warn',
  critical: 'bg-fail',
};

const labelTone: Record<Tone, string> = {
  normal: 'text-text-muted',
  warning: 'text-warn',
  critical: 'text-fail',
};

interface MeterProps {
  /** 0-100+; values above 100 are clamped for the bar's width but still shown in the label. */
  usedPct: number;
  tone: Tone;
  label?: string;
  hint?: string;
}

/**
 * Capacity plan Fase 3 — a threshold-colored usage bar, used everywhere
 * `/api/admin/capacity` reports a `{ usedPct, status }` pair (node cards,
 * the infra dashboard, the node edit modal's live preview). `tone` comes
 * straight from the backend's own `capacityStatus()` (capacity.math.ts)
 * rather than being recomputed here — one threshold definition, not two.
 */
export function Meter({ usedPct, tone, label, hint }: MeterProps) {
  const width = Math.max(0, Math.min(usedPct, 100));
  return (
    <div>
      {(label || hint) && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          {label && <span className="text-text-muted">{label}</span>}
          {hint && <span className={`font-mono tabular-nums ${labelTone[tone]}`}>{hint}</span>}
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-[width] ${barTone[tone]}`}
          style={{ width: `${width}%` }}
          role="progressbar"
          aria-valuenow={Math.round(usedPct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
