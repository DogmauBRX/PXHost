import { forwardRef, useImperativeHandle, useRef } from 'react';

type Tone = 'normal' | 'warning' | 'critical';

// Same three-tone vocabulary as Meter (usage bars elsewhere in the app) —
// one severity naming convention across the whole panel, not two.
const TONE_VAR: Record<Tone, string> = {
  normal: 'var(--color-ok)',
  warning: 'var(--color-warn)',
  critical: 'var(--color-fail)',
};

const SIZE = { w: 200, h: 128, cx: 100, cy: 104, r: 84, stroke: 14 };

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Half-circle gauge, flat side down: -90deg (9 o'clock) sweeping clockwise
// through the top to +90deg (3 o'clock). largeArcFlag is always '0' here —
// the sweep this component ever draws tops out at exactly 180deg (100%).
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

const TRACK_PATH = describeArc(SIZE.cx, SIZE.cy, SIZE.r, -90, 90);

export interface GaugeHandle {
  /** `percent` positions the needle arc (0-100, clamped); `tone` colors it; the two text lines are freeform so callers can show whatever unit fits (%, MB, cores…). */
  update(percent: number, tone: Tone, valueText: string, detailText: string): void;
}

interface GaugeProps {
  label: string;
  /** Shown before the first `update()` call — CPU/RAM arrive on their own (a live stream), storage is measured on demand, so its default reads differently ("nunca medido" vs. "aguardando dados"). */
  initialDetailText?: string;
}

/**
 * A speedometer-style radial gauge — CPU/RAM's replacement for the trend
 * line chart (uPlot) this used to be, whose bare axis numbers were the
 * actual complaint. Updates are imperative (`ref.update(...)`) rather
 * than through React props: a live stats frame arrives every ~2s, and
 * per architecture doc 5.2 that must never re-render this page's React
 * tree — only the SVG arc's `d`/stroke attributes and two text nodes are
 * touched directly.
 */
export const Gauge = forwardRef<GaugeHandle, GaugeProps>(function Gauge({ label, initialDetailText = 'aguardando dados…' }, ref) {
  const arcRef = useRef<SVGPathElement>(null);
  const valueRef = useRef<SVGTextElement>(null);
  const detailRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    update(percent, tone, valueText, detailText) {
      const clamped = Math.max(0, Math.min(100, percent));
      const angle = -90 + (clamped / 100) * 180;
      if (arcRef.current) {
        arcRef.current.setAttribute('d', describeArc(SIZE.cx, SIZE.cy, SIZE.r, -90, angle));
        arcRef.current.setAttribute('stroke', TONE_VAR[tone]);
      }
      if (valueRef.current) valueRef.current.textContent = valueText;
      if (detailRef.current) {
        detailRef.current.textContent = detailText;
        // Normal usage stays neutral (text-faint); anything else borrows
        // the same tone as the arc, so the detail line itself reads as
        // the "aviso" (warning) — not just a color on the gauge nobody
        // reads as an alert on its own.
        detailRef.current.style.color = tone === 'normal' ? '' : TONE_VAR[tone];
      }
    },
  }));

  return (
    <div className="flex flex-1 flex-col items-center">
      <svg viewBox={`0 0 ${SIZE.w} ${SIZE.h}`} className="w-full max-w-[220px]" role="img" aria-label={label}>
        <path d={TRACK_PATH} fill="none" stroke="var(--color-surface-2)" strokeWidth={SIZE.stroke} strokeLinecap="round" />
        <path
          ref={arcRef}
          d={describeArc(SIZE.cx, SIZE.cy, SIZE.r, -90, -90)}
          fill="none"
          stroke="var(--color-ok)"
          strokeWidth={SIZE.stroke}
          strokeLinecap="round"
          style={{ transition: 'd 0.5s ease, stroke 0.3s ease' }}
        />
        <text
          ref={valueRef}
          x={SIZE.cx}
          y={SIZE.cy - 6}
          textAnchor="middle"
          style={{ fill: 'var(--color-text)', fontSize: 28, fontWeight: 700 }}
        >
          —
        </text>
        <text x={SIZE.cx} y={SIZE.cy + 18} textAnchor="middle" style={{ fill: 'var(--color-text-faint)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
          {label.toUpperCase()}
        </text>
      </svg>
      <span ref={detailRef} className="-mt-1 font-mono text-xs text-text-faint">
        {initialDetailText}
      </span>
    </div>
  );
});
