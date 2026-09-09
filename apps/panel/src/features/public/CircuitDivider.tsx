import { useId } from 'react';

/**
 * A single glowing vertical circuit trace dividing the provisioning
 * section's two blocks — deliberately minimal (one line, one junction
 * node, two traveling packets), not the dense `HeroCircuitBackground`
 * pattern tried here first: reusing that whole backdrop read as "too
 * much fill" behind a section that just needed a clean seam between two
 * pieces of information (found live). Same neon-glow technique
 * (`feGaussianBlur` + `feMerge`) and SMIL packet travel as
 * `NetworkAnimation`'s own connection lines — this is that same visual
 * language reduced to its simplest form: one wire.
 */
export function CircuitDivider({ className = '' }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const glowId = `divider-glow-${uid}`;

  return (
    <svg viewBox="0 0 40 400" preserveAspectRatio="none" className={className} aria-hidden="true">
      <defs>
        {/* userSpaceOnUse — a perfectly vertical line has a zero-WIDTH
            bounding box, the same degenerate case (just the other axis)
            that broke NetworkAnimation's own horizontal connections
            under the objectBoundingBox default earlier in this project. */}
        <filter id={glowId} filterUnits="userSpaceOnUse" x="-30" y="-30" width="100" height="460">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <line x1="20" y1="0" x2="20" y2="400" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.8" filter={`url(#${glowId})`} />

      {/* Junction node at the midpoint — the "wire meets a component" beat
          from a real PCB trace. No pulsing ring here (tried first, same
          `.brazil-node-ring` as the map's city nodes) — this SVG's
          `preserveAspectRatio="none"` stretches the tall/narrow viewport
          non-uniformly, so a circle's `scale()` pulse rendered as a
          static-looking elongated blob instead of a clean radial pulse. */}
      <circle cx="20" cy="200" r="5" fill="var(--color-accent-strong)" filter={`url(#${glowId})`} />

      {/* Two packets traveling in opposite directions, offset in time — reads as current flowing both ways along the wire. */}
      <circle r="3.5" fill="var(--color-accent)" className="network-packet">
        <animateMotion dur="3s" repeatCount="indefinite" path="M20,0 L20,400" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3s" repeatCount="indefinite" />
      </circle>
      <circle r="3" fill="var(--color-accent-strong)" className="network-packet">
        <animateMotion dur="3s" begin="1.5s" repeatCount="indefinite" path="M20,400 L20,0" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3s" begin="1.5s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
