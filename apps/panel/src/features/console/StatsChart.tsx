import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import UPlot from 'uplot';
import type { StatsFrame } from '@/shared/realtime/protocol';

export interface StatsChartHandle {
  pushFrame: (frame: StatsFrame) => void;
}

const WINDOW_POINTS = 60; // ~2 minutes at the agent's 2s push interval

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
    if (!containerRef.current) return;
    const chart = new UPlot(
      {
        width: containerRef.current.clientWidth || 400,
        height: 160,
        legend: { show: false },
        cursor: { show: false },
        axes: [
          { stroke: '#6c7b82', grid: { stroke: '#263038' }, ticks: { show: false } },
          { scale: 'cpu', stroke: '#57b5a0', grid: { show: false }, ticks: { show: false }, size: 34 },
          { scale: 'mem', stroke: '#d1a24f', side: 1, grid: { show: false }, ticks: { show: false }, size: 42 },
        ],
        scales: { cpu: { range: [0, 100] }, mem: { range: (_u, _min, max) => [0, Math.max(max, 64)] } },
        series: [
          {},
          { label: 'CPU %', stroke: '#57b5a0', width: 1.5, scale: 'cpu', points: { show: false } },
          { label: 'RAM MB', stroke: '#d1a24f', width: 1.5, scale: 'mem', points: { show: false } },
        ],
      },
      [new Float64Array(0), new Float64Array(0), new Float64Array(0)],
      containerRef.current,
    );
    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) chart.setSize({ width: containerRef.current.clientWidth, height: 160 });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-full bg-accent" /> CPU
          </span>
          <span className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-full bg-warn" /> RAM
          </span>
        </div>
        <span data-readout className="font-mono text-xs text-text-faint">
          aguardando dados…
        </span>
      </div>
      <div ref={containerRef} />
    </div>
  );
});
