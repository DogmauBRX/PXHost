import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import UPlot from 'uplot';
import type { StatsFrame } from '@/shared/realtime/protocol';
import { readToken } from '@/shared/theme/tokens';
import { THEME_CHANGE_EVENT } from '@/shared/theme/theme.store';

export interface StatsChartHandle {
  pushFrame: (frame: StatsFrame) => void;
}

const WINDOW_POINTS = 60; // ~2 minutes at the agent's 2s push interval
// One constant for both the constructor and the ResizeObserver — these were
// two separate literals before, which is how they drift apart.
const CHART_HEIGHT = 200;

// A plain useRef ring buffer fed straight into uPlot.setData() on every
// incoming frame — no React state, so a server streaming stats every
// couple seconds never triggers a React re-render on this page
// (architecture doc 5.2).
export const StatsChart = forwardRef<StatsChartHandle>(function StatsChart(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<UPlot | null>(null);
  const bufRef = useRef({ t: new Float64Array(WINDOW_POINTS), cpu: new Float64Array(WINDOW_POINTS), mem: new Float64Array(WINDOW_POINTS), n: 0 });
  const latestRef = useRef({ cpu: 0, memMb: 0, limitMb: 0 });

  useImperativeHandle(ref, () => ({
    pushFrame(frame: StatsFrame) {
      const buf = bufRef.current;
      const memMb = frame.memory_bytes / 1024 / 1024;
      if (buf.n < WINDOW_POINTS) {
        buf.t[buf.n] = Date.now() / 1000;
        buf.cpu[buf.n] = frame.cpu_percent;
        buf.mem[buf.n] = memMb;
        buf.n += 1;
      } else {
        buf.t.copyWithin(0, 1);
        buf.cpu.copyWithin(0, 1);
        buf.mem.copyWithin(0, 1);
        buf.t[WINDOW_POINTS - 1] = Date.now() / 1000;
        buf.cpu[WINDOW_POINTS - 1] = frame.cpu_percent;
        buf.mem[WINDOW_POINTS - 1] = memMb;
      }
      latestRef.current = { cpu: frame.cpu_percent, memMb, limitMb: frame.memory_limit_bytes / 1024 / 1024 };
      const readout = containerRef.current?.parentElement?.querySelector('[data-readout]');
      if (readout) {
        readout.textContent = `CPU ${frame.cpu_percent.toFixed(1)}%  ·  RAM ${memMb.toFixed(0)} / ${(frame.memory_limit_bytes / 1024 / 1024).toFixed(0)} MB`;
      }
      chartRef.current?.setData([buf.t.subarray(0, buf.n), buf.cpu.subarray(0, buf.n), buf.mem.subarray(0, buf.n)]);
    },
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // uPlot takes colors as plain strings and cannot read CSS variables, so
    // the palette has to be resolved here at build time. Reading the tokens
    // (rather than hardcoding hexes, as this file used to) is what keeps the
    // chart legible after a theme switch. RAM is drawn in `info` rather than
    // `warn` because amber next to the orange accent is near-indistinguishable.
    function build(): UPlot | null {
      if (!el) return null;
      const chart = new UPlot(
        {
          width: el.clientWidth || 400,
          height: CHART_HEIGHT,
          legend: { show: false },
          cursor: { show: false },
          axes: [
            { stroke: readToken('--color-text-faint'), grid: { stroke: readToken('--color-border') }, ticks: { show: false } },
            { scale: 'cpu', stroke: readToken('--color-accent'), grid: { show: false }, ticks: { show: false }, size: 34 },
            { scale: 'mem', stroke: readToken('--color-info'), side: 1, grid: { show: false }, ticks: { show: false }, size: 42 },
          ],
          scales: { cpu: { range: [0, 100] }, mem: { range: (_u, _min, max) => [0, Math.max(max, 64)] } },
          series: [
            {},
            { label: 'CPU %', stroke: readToken('--color-accent'), width: 1.5, scale: 'cpu', points: { show: false } },
            { label: 'RAM MB', stroke: readToken('--color-info'), width: 1.5, scale: 'mem', points: { show: false } },
          ],
        },
        [new Float64Array(0), new Float64Array(0), new Float64Array(0)],
        el,
      );
      // Replay whatever the ring buffer already holds, so rebuilding on a
      // theme switch never drops accumulated history.
      const buf = bufRef.current;
      if (buf.n > 0) chart.setData([buf.t.subarray(0, buf.n), buf.cpu.subarray(0, buf.n), buf.mem.subarray(0, buf.n)]);
      return chart;
    }

    chartRef.current = build();

    const resizeObserver = new ResizeObserver(() => {
      if (el) chartRef.current?.setSize({ width: el.clientWidth, height: CHART_HEIGHT });
    });
    resizeObserver.observe(el);

    // uPlot has no public "restyle an existing chart" API, so a theme change
    // means destroy and rebuild. That is fine precisely because it is a rare,
    // user-initiated event — and it is driven by a DOM event rather than
    // React state, so the per-second stats path stays render-free.
    const onThemeChange = () => {
      chartRef.current?.destroy();
      chartRef.current = build();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      resizeObserver.disconnect();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-full bg-accent" /> CPU
          </span>
          <span className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-full bg-info" /> RAM
          </span>
        </div>
        <span data-readout className="font-mono text-xs text-text-faint">
          aguardando dados…
        </span>
      </div>
      {/* pushFrame writes the readout above by walking up from this node —
          keep it a sibling under the same parent if this markup moves. */}
      <div ref={containerRef} />
    </div>
  );
});
