import { useId } from 'react';
import { CircuitPattern } from '@/ui/brand/CircuitPattern';

/**
 * The "cobertura nacional" hero visual — an actual Brazil silhouette
 * (traced from a real country-boundary GeoJSON, equirectangular-
 * projected into this viewBox — not hand-drawn, after a first attempt
 * at freehand-approximating the coastline came out unrecognizable)
 * filled with the same chip-trace `CircuitPattern` used on the plans
 * hero, clipped to the country's own shape via `clipPath`, with a
 * handful of real cities pulsing as "network nodes" to sell the "baixa
 * latência em todo o território" claim visually instead of just
 * asserting it in prose. Purely decorative (`aria-hidden`) — no real
 * per-region latency telemetry backs these dots.
 */
const CITIES = [
  { name: 'Manaus', x: 170.1, y: 109.1 },
  { name: 'Recife', x: 442.8, y: 162.7 },
  { name: 'Brasília', x: 301.3, y: 246.5 },
  { name: 'São Paulo', x: 315.3, y: 330.8 },
  { name: 'Rio de Janeiro', x: 352.9, y: 323.8 },
  { name: 'Porto Alegre', x: 265.6, y: 401.1 },
] as const;

// Projected from the national boundary polygon (single ring, 203 points)
// of a public Brazil country GeoJSON — plain equirectangular (x = lon,
// y = -lat) scaled to this viewBox with a 4% margin, not a map
// projection library; accurate enough for a decorative silhouette at
// this scale, not a survey/GIS-grade boundary.
const BRAZIL_PATH =
  'M196.1,403.1 L210.5,388.3 L222.8,377.7 L230.1,373.3 L239.2,367.3 L239.4,358.7 L234,352.4 L228.6,354.5 L230.7,348.2 L232.2,341.8 L232.2,335.9 L228.3,333.9 L224.2,335.6 L220.2,335.2 L218.9,331 L217.9,321.1 L215.9,317.8 L208.6,314.9 L204.1,317 L192.7,314.9 L193.4,300.2 L190.2,294.2 L193.6,291.9 L192.5,285.7 L195.5,281 L197.4,272.4 L194.9,265.7 L188.9,262.6 L187.8,258.4 L189.4,252.1 L168.6,251.7 L164.4,239 L167.6,238.8 L167.4,234.2 L165.3,231 L164.8,224.7 L158.5,221.5 L151.7,221.6 L147.2,218.5 L139.9,216.3 L135.6,212.3 L123.5,210.5 L111.7,200.8 L112.5,193.5 L111.2,189.3 L112.4,181.2 L98.2,183 L92.4,187.1 L83,191.5 L80.5,194.8 L75,195 L66.9,194.1 L60.8,196 L55.8,194.7 L56.6,178.2 L47.7,184.6 L38.1,184.3 L34,178.6 L26.8,177.9 L29.1,173.3 L23,166.7 L18.5,156.9 L21.4,154.9 L21.4,150.3 L27.9,147.2 L26.8,141.3 L29.6,137.6 L30.4,132.5 L42.8,125.1 L51.7,123 L53.2,121.4 L62.9,121.9 L67.8,92.2 L68.1,87.5 L66.4,81.3 L61.6,77.3 L61.6,69.4 L67.7,67.6 L69.9,68.8 L70.3,64.6 L63.9,63.5 L63.8,56.7 L84.9,56.9 L88.5,53.2 L91.5,56.6 L93.6,63 L95.7,61.7 L101.7,67.4 L110.1,66.7 L112.2,63.4 L120.3,60.9 L124.7,59.1 L126,54.5 L133.7,51.4 L133.1,49.1 L124,48.2 L122.5,41.4 L122.9,34.1 L118,31.3 L120.1,30.3 L128.1,31.7 L136.7,34.4 L139.9,31.8 L147.7,30.1 L159.8,26.1 L163.8,21.9 L162.3,18.9 L168,18.4 L170.5,20.9 L169.1,25.7 L172.8,27.3 L175.3,32.3 L172.3,36.2 L170.6,45.4 L173.3,50.9 L174.1,55.9 L180.8,61 L186.1,61.5 L187.3,59.4 L190.8,58.9 L195.7,57 L199.2,54.2 L205.2,55.1 L207.8,54.7 L213.7,55.6 L214.7,53.4 L212.9,51.2 L214,48.1 L218.4,49 L223.5,47.9 L229.7,50.2 L234.4,52.5 L237.8,49.5 L240.2,50 L241.7,53 L246.9,52.2 L251.1,48.1 L254.4,40.1 L260.8,30.2 L264.5,29.7 L267.2,35.7 L273.3,54.7 L279.1,56.5 L279.4,63.9 L271.2,72.9 L274.6,76.1 L293.8,77.8 L294.2,88.7 L302.4,81.6 L316,85.5 L334.1,92.1 L339.4,98.5 L337.6,104.5 L350.2,101.1 L371.3,106.9 L387.5,106.5 L403.6,115.4 L417.4,127.6 L425.8,130.7 L435.1,131.2 L439,134.6 L442.7,148.4 L444.5,154.9 L440.2,172.9 L434.6,180 L419.3,195.1 L412.4,207.3 L404.4,216.7 L401.7,216.9 L398.7,224.9 L399.4,245.2 L396.4,262 L395.2,269.1 L391.8,273.4 L389.9,287.9 L378.9,302.1 L377,313.3 L368.3,318 L365.7,324.5 L353.9,324.4 L336.9,328.6 L329.2,333.4 L317.1,336.6 L304.3,345.2 L295.1,356 L293.5,364.1 L295.3,370.1 L293.3,381 L290.9,386.3 L283.3,392.3 L271.2,411.4 L261.7,420 L254.3,425.1 L249.4,435.4 L242.2,441.6 L239.2,435.5 L244,430.3 L237.7,422.9 L229.2,416.9 L218,410 L214,410.3 L203.1,401.9 Z';

export function BrazilLatencyMap() {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const clipId = `brazil-clip-${uid}`;
  const glowId = `brazil-glow-${uid}`;
  const fillGradId = `brazil-fill-${uid}`;

  return (
    <div className="relative mx-auto aspect-[463/460] w-full max-w-sm select-none" aria-hidden="true">
      <svg viewBox="0 0 463 460" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <clipPath id={clipId}>
            <path d={BRAZIL_PATH} />
          </clipPath>
          <linearGradient id={fillGradId} x1="0" y1="0" x2="463" y2="460" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--color-accent-strong)" stopOpacity="0.18" />
          </linearGradient>
          <filter id={glowId} filterUnits="userSpaceOnUse" x="-40" y="-40" width="540" height="540">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Base territory fill, then the circuit pattern clipped to the same silhouette. */}
        <path d={BRAZIL_PATH} fill={`url(#${fillGradId})`} />
        <g clipPath={`url(#${clipId})`}>
          <CircuitPattern className="h-[460px] w-[463px]" />
        </g>

        {/* The outline itself, glowing — reads as the territory's edge lighting up. */}
        <path d={BRAZIL_PATH} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" filter={`url(#${glowId})`} />

        {/* City nodes — small pulsing pads, same "network" language as NetworkAnimation. */}
        {CITIES.map((city, i) => (
          <g key={city.name}>
            <circle cx={city.x} cy={city.y} r="10" fill="var(--color-accent)" opacity="0.18" className="brazil-node-ring" style={{ animationDelay: `${i * -0.6}s` }} />
            <circle cx={city.x} cy={city.y} r="3.5" fill="var(--color-accent-strong)" stroke="var(--color-surface)" strokeWidth="1.2" />
          </g>
        ))}
      </svg>
    </div>
  );
}
