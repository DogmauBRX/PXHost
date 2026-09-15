import { Server } from 'lucide-react';
import { Logo } from '@/ui/brand/Logo';

/**
 * "GXhost Network" — the landing page's hero visual. A central node
 * (the GXhost mark) with six satellite servers arranged in a hexagon
 * (the Logo's own shape, made literal at scene scale), connected by
 * animated lines with data packets traveling along them, each node
 * cycling through Online → Deploying → Running.
 *
 * Pure SVG + CSS (the `<animateMotion>` SMIL elements move the packet
 * dots along each connection's exact path; everything else is a CSS
 * `@keyframes` loop) — same posture as `CircuitPattern.tsx` and the
 * wordmark shimmer: no animation library, every color a CSS custom
 * property so it repaints correctly in both themes for free. Purely
 * decorative (`aria-hidden`) — nothing here is real infrastructure
 * telemetry, so it must never be mistaken for the admin dashboard's own
 * live node status.
 */
const NODES = [
  { xPct: 84, yPct: 50, svgX: 420, svgY: 250 },
  { xPct: 67, yPct: 20.6, svgX: 335, svgY: 103 },
  { xPct: 33, yPct: 20.6, svgX: 165, svgY: 103 },
  { xPct: 16, yPct: 50, svgX: 80, svgY: 250 },
  { xPct: 33, yPct: 79.4, svgX: 165, svgY: 397 },
  { xPct: 67, yPct: 79.4, svgX: 335, svgY: 397 },
];

const CENTER = { x: 250, y: 250 };

export function NetworkAnimation() {
  return (
    <div className="relative isolate mx-auto aspect-square w-full max-w-xl select-none" aria-hidden="true">
      {/* An opaque panel behind the whole diagram — without it, this scene
          sits directly on `HeroCircuitBackground` (LandingPage.tsx's own
          PCB-trace backdrop, same brand orange), and blended into it even
          with a soft vignette here (found live, in both light AND dark
          mode: reported as "it blends into the page background too
          much"). A real bordered/shadowed "screen" reads as a distinct
          surface the diagram is displayed ON, not just a faded patch.
          `isolate` on the wrapper above is load-bearing: without it, this
          div's own `position:relative` doesn't start a new stacking
          context, so `-z-10` doesn't just go "behind this component's own
          SVG/cards" — it escapes to the nearest ancestor that DOES form
          one and can end up behind nearly the whole page instead (found
          live: the panel was rendering, fully styled, just invisible
          under everything else — not merely "too subtle" as first
          assumed). `isolate` pins the stacking context here so -z-10
          only means "behind this component's own children." */}
      <div className="network-panel absolute inset-x-[4%] inset-y-[14%] -z-10 rounded-[2rem]" />
      <svg viewBox="0 0 500 500" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          {/* userSpaceOnUse with FIXED coordinates spanning the whole
              viewBox — not the default objectBoundingBox, which is
              degenerate (renders invisible) for a shape whose bounding
              box is zero-height or zero-width. The two horizontal
              connections (the left/right nodes, both sharing the
              center's own y) are EXACTLY that shape: found live, only
              those two lines never painted while the four diagonal
              ones did, because a diagonal x1/y1→x2/y2 gradient can't be
              expressed against a bounding box with no height. */}
          <linearGradient id="network-line-grad" x1="0" y1="0" x2="500" y2="500" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--color-accent-strong)" stopOpacity="0.6" />
          </linearGradient>
          {/* Bloomed copy merged under the crisp line — same neon technique
              as HeroCircuitBackground's own traces (LandingPage.tsx), so
              this diagram's lines carry their own glow instead of relying
              only on the vignette behind them to read over that backdrop.
              `filterUnits="userSpaceOnUse"` with fixed viewBox coordinates
              — not the objectBoundingBox default, which is degenerate
              (renders nothing at all) for a zero-height bounding box.
              Same bug shape as the gradient above: the two horizontal
              connections share the center's own y, so their percentage-
              based filter region couldn't be computed and those two lines
              vanished under the filter entirely. */}
          <filter id="network-line-glow" filterUnits="userSpaceOnUse" x="-50" y="-50" width="600" height="600">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {NODES.map((node, i) => {
          const d = `M${CENTER.x},${CENTER.y} L${node.svgX},${node.svgY}`;
          return (
            <g key={i}>
              {/* A surface-colored "casing" stroke first — cuts a clean gap
                  between this line and the hero's own PCB-trace backdrop
                  (same brand orange), which the gradient line alone was too
                  thin/translucent to hold its own against. */}
              <path d={d} fill="none" stroke="var(--color-surface)" strokeWidth="7" strokeLinecap="round" opacity="0.9" />
              <path d={d} fill="none" stroke="url(#network-line-grad)" strokeWidth="2.75" strokeLinecap="round" filter="url(#network-line-glow)" />
              {/* Two packets per line, offset in time, so the connection never reads as idle. */}
              <circle r="4.5" fill="var(--color-accent)" className="network-packet">
                <animateMotion dur="3s" begin={`${i * 0.4}s`} repeatCount="indefinite" path={d} />
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
              </circle>
              <circle r="3.5" fill="var(--color-accent-strong)" className="network-packet">
                <animateMotion dur="3s" begin={`${i * 0.4 + 1.5}s`} repeatCount="indefinite" path={d} />
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin={`${i * 0.4 + 1.5}s`} repeatCount="indefinite" />
              </circle>
            </g>
          );
        })}
      </svg>

      {/* Center node — the GXhost mark itself, with a soft pulsing glow standing in for "the network's heart." */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="network-glow-pulse absolute inset-0 -z-10 rounded-full bg-accent" />
        <div className="rounded-2xl border border-accent/40 bg-surface p-4 shadow-lg">
          <Logo size={44} />
        </div>
      </div>

      {NODES.map((node, i) => {
        const delay = `${i * -1.5}s`;
        return (
          <div
            key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${node.xPct}%`, top: `${node.yPct}%` }}
          >
            <div className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface/70 px-3 py-2 shadow-sm backdrop-blur-xl">
              <div className="relative">
                <Server className="h-4 w-4 text-text-muted" />
                <span className="network-status-dot absolute -top-1 -right-1 h-2 w-2 rounded-full" style={{ animationDelay: delay }} />
              </div>
              <div className="relative h-3 w-16 text-center font-mono text-[9px] tracking-wide uppercase text-text-faint">
                <span className="network-status-a absolute inset-0" style={{ animationDelay: delay }}>
                  Online
                </span>
                <span className="network-status-b absolute inset-0" style={{ animationDelay: delay }}>
                  Deploying
                </span>
                <span className="network-status-c absolute inset-0" style={{ animationDelay: delay }}>
                  Running
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
