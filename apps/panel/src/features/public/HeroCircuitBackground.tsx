import { useId } from 'react';

/**
 * The landing hero's backdrop artwork — a glowing PCB trace diagram in the
 * brand's orange, replacing `CircuitPattern`'s small tileable chip-trace
 * motif here specifically (that one still backs the plan cards and the
 * sidebar brand block; this is a single large hand-authored scene, not a
 * repeating tile, so segment lengths and bend spacing can vary the way a
 * real board's traces do instead of visibly repeating every N pixels).
 * Three depth layers (faint / mid / bright, each its own opacity and glow
 * strength) give the "traces feeding into a lit component" read instead of
 * a flat wash. `viewBox`/`preserveAspectRatio` scale-and-crop it to
 * whatever the caller's box is (see `.network-hero__circuit` in index.css
 * for the radial fade masking it toward the hero's text side, and
 * `.login-hero__circuit` for the auth screens' full-bleed, unmasked use of
 * the same component).
 *
 * Glow vs. animation are deliberately on SEPARATE elements now (reported
 * live: "as páginas com a animação estão travando"). The original version
 * ran `stroke-dashoffset` (trace flow) and `transform`/`opacity` (pad
 * pulse) animations on the SAME elements a `feGaussianBlur`+`feMerge`
 * filter was applied to — an SVG filter forces the browser back to
 * software rasterization on every frame its input changes, so animating
 * ~25 paths and 15 circles *inside* their own blur filters meant re-
 * blurring that whole scene 60 times a second. Splitting each glowing
 * shape into a STATIC blurred copy (filtered once, then cached — its
 * content never changes, so there's nothing to re-blur) underneath a
 * CRISP animated copy with no filter at all (a plain stroke/transform
 * repaint, orders of magnitude cheaper, and transform/opacity are
 * compositor-only) keeps the exact same visual glow while removing the
 * per-frame refilter cost entirely.
 */
const MID_PATHS = [
  'M0,110 L90,110 L112,132 L112,220 L150,258',
  'M60,0 L60,30 L96,66 L96,150',
  'M240,20 L240,80 L280,120 L280,190',
  'M180,260 L260,260 L280,280 L360,280',
  'M0,320 L46,320 L46,380 L90,424',
  'M140,470 L140,540 L180,580',
  'M420,180 L470,180 L490,200 L560,200',
  'M400,300 L400,340 L440,380 L440,440',
  'M340,560 L380,560 L400,540 L460,540',
  'M600,140 L640,140 L640,90 L680,50',
  'M540,260 L600,260 L620,280 L680,280',
  'M620,360 L680,360 L700,380 L700,440',
  'M760,120 L800,120 L820,140 L820,200',
  'M840,240 L900,240 L916,256 L916,320',
  'M760,300 L760,360 L800,400 L800,460',
  'M860,400 L900,400 L920,420 L920,480',
  'M700,500 L740,500 L760,480 L820,480',
  'M600,460 L600,520 L560,560',
  'M960,60 L916,60 L900,76 L840,76',
  'M0,500 L40,500 L60,480 L60,440',
];

const BRIGHT_PATHS = [
  'M500,220 L560,220 L580,240 L660,240',
  'M600,240 L600,300 L640,340 L640,400',
  'M720,260 L720,320 L680,360',
  'M660,400 L720,400 L740,420 L800,420',
  'M560,340 L560,380 L520,420 L520,470',
];

const DIM_PADS: { cx: number; cy: number; r: number }[] = [
  { cx: 138, cy: 140, r: 2.4 },
  { cx: 240, cy: 216, r: 2 },
  { cx: 360, cy: 46, r: 2 },
  { cx: 470, cy: 150, r: 2.4 },
  { cx: 100, cy: 280, r: 2.2 },
  { cx: 600, cy: 120, r: 2 },
  { cx: 740, cy: 70, r: 2 },
  { cx: 880, cy: 140, r: 2.4 },
  { cx: 820, cy: 220, r: 2.2 },
  { cx: 60, cy: 560, r: 2.2 },
  { cx: 864, cy: 520, r: 2.4 },
  { cx: 340, cy: 420, r: 2 },
  { cx: 500, cy: 500, r: 2 },
  { cx: 660, cy: 400, r: 2 },
  { cx: 460, cy: 520, r: 2 },
];

const BRIGHT_PADS: { cx: number; cy: number; r: number; delay: string }[] = [
  { cx: 660, cy: 240, r: 3.2, delay: '0s' },
  { cx: 640, cy: 400, r: 3, delay: '0.5s' },
  { cx: 680, cy: 360, r: 3, delay: '1s' },
  { cx: 800, cy: 420, r: 3.2, delay: '1.5s' },
  { cx: 520, cy: 470, r: 3, delay: '2s' },
  { cx: 150, cy: 258, r: 2.8, delay: '0.2s' },
  { cx: 280, cy: 190, r: 2.6, delay: '0.7s' },
  { cx: 90, cy: 424, r: 2.6, delay: '1.2s' },
  { cx: 180, cy: 580, r: 2.6, delay: '1.7s' },
  { cx: 680, cy: 50, r: 2.6, delay: '2.2s' },
  { cx: 820, cy: 200, r: 2.6, delay: '0.35s' },
  { cx: 916, cy: 320, r: 2.6, delay: '0.85s' },
  { cx: 800, cy: 460, r: 2.6, delay: '1.35s' },
  { cx: 560, cy: 560, r: 2.6, delay: '1.85s' },
  { cx: 840, cy: 76, r: 2.6, delay: '2.35s' },
];

export function HeroCircuitBackground({ className = '' }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const glowSoft = `pcb-glow-soft-${uid}`;
  const glowStrong = `pcb-glow-strong-${uid}`;

  return (
    <svg className={className} viewBox="0 0 960 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <filter id={glowSoft} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={glowStrong} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Faint background layer — thin, low-opacity, no glow, just fills out the board. Already static; no filter to begin with, so it was never part of the jank. */}
      <g fill="none" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round" opacity="0.28">
        <path d="M0,40 L120,40 L138,58 L138,140" />
        <path d="M180,0 L180,64 L204,88 L204,180 L240,216" />
        <path d="M320,0 L320,46 L360,46" />
        <path d="M420,0 L420,90 L470,90 L470,150" />
        <path d="M0,180 L60,180 L60,240 L100,280" />
        <path d="M560,0 L560,54 L600,54 L600,120" />
        <path d="M700,0 L700,70 L740,70" />
        <path d="M840,0 L840,60 L880,60 L880,140" />
        <path d="M960,200 L900,200 L880,220 L820,220" />
        <path d="M0,420 L80,420 L96,436 L96,520 L60,560" />
        <path d="M960,420 L880,420 L864,436 L864,520" />
        <path d="M300,600 L300,520 L340,480 L340,420" />
        <path d="M540,600 L540,540 L500,500" />
        <path d="M700,600 L700,520 L660,480 L660,400" />
        <path d="M420,600 L420,560 L460,520" />
      </g>

      {/* Mid layer — static blurred copy (filtered once, cached; never re-blurred since it never changes) underneath a crisp, unfiltered, animated copy on top. */}
      <g fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" filter={`url(#${glowSoft})`}>
        {MID_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g className="circuit-trace-flow" fill="none" stroke="var(--color-accent)" strokeWidth="1.3" strokeLinecap="round" opacity="0.75">
        {MID_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* Bright layer — same static-glow + crisp-animated split, closest to the network node the hero sits next to. */}
      <g fill="none" stroke="var(--color-accent-strong)" strokeWidth="2" strokeLinecap="round" opacity="0.7" filter={`url(#${glowStrong})`}>
        {BRIGHT_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g className="circuit-trace-flow" fill="none" stroke="var(--color-accent-strong)" strokeWidth="1.7" strokeLinecap="round" opacity="0.95">
        {BRIGHT_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* Pads — small filled circles at trace terminals and a few junctions, brighter where the traces themselves are brighter. Static, unfiltered — cheap either way. */}
      <g fill="var(--color-accent)" opacity="0.4">
        {DIM_PADS.map((p) => (
          <circle key={`${p.cx}-${p.cy}`} cx={p.cx} cy={p.cy} r={p.r} />
        ))}
      </g>

      {/* Junctions "power on" in a staggered pulse. Same static-glow /
          crisp-animated split as the traces above: a non-animated blurred
          dot per junction (filtered once) sits under a small unfiltered
          circle that actually pulses via `.circuit-pad-pulse`
          (transform+opacity — compositor-only once it's not inside a
          filter). */}
      <g fill="var(--color-accent-strong)" opacity="0.55" filter={`url(#${glowStrong})`}>
        {BRIGHT_PADS.map((p) => (
          <circle key={`${p.cx}-${p.cy}-glow`} cx={p.cx} cy={p.cy} r={p.r} />
        ))}
      </g>
      <g fill="var(--color-accent-strong)">
        {BRIGHT_PADS.map((p) => (
          <circle key={`${p.cx}-${p.cy}-pulse`} className="circuit-pad-pulse" style={{ animationDelay: p.delay }} cx={p.cx} cy={p.cy} r={p.r * 0.85} />
        ))}
      </g>
    </svg>
  );
}
