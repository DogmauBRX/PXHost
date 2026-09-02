import { useId } from 'react';

/**
 * A tileable "chip trace" motif — hexagon nodes (echoing Logo's own shape)
 * joined by right-angle traces with via-dots, built as a real SVG
 * `<pattern>` rather than a CSS data-URI so it can read the theme's own
 * `var(--color-accent)` directly (a data-URI background-image is a
 * separate resource context and can't see the page's custom properties).
 * Every tile's edge-traces land exactly on the tile boundary, so repeats
 * connect into one continuous board rather than visibly seaming.
 * Absolutely positioned by the caller; this component only draws.
 */
export function CircuitPattern({ className = '' }: { className?: string }) {
  const id = `circuit-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg className={className} aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id={id} width="72" height="72" patternUnits="userSpaceOnUse">
          <path
            d="M36 20 49.86 28 49.86 44 36 52 22.14 44 22.14 28Z"
            fill="none"
            stroke="var(--color-accent)"
            strokeOpacity="0.55"
            strokeWidth="1"
          />
          <path
            d="M36 0V20M36 52V72M0 36H22.14M49.86 36H72"
            fill="none"
            stroke="var(--color-accent)"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
          <circle cx="36" cy="0" r="1.5" fill="var(--color-accent)" fillOpacity="0.6" />
          <circle cx="36" cy="72" r="1.5" fill="var(--color-accent)" fillOpacity="0.6" />
          <circle cx="0" cy="36" r="1.5" fill="var(--color-accent)" fillOpacity="0.6" />
          <circle cx="72" cy="36" r="1.5" fill="var(--color-accent)" fillOpacity="0.6" />
          <circle cx="36" cy="20" r="1.3" fill="var(--color-accent)" fillOpacity="0.65" />
          <circle cx="36" cy="52" r="1.3" fill="var(--color-accent)" fillOpacity="0.65" />
          <circle cx="22.14" cy="36" r="1.3" fill="var(--color-accent)" fillOpacity="0.65" />
          <circle cx="49.86" cy="36" r="1.3" fill="var(--color-accent)" fillOpacity="0.65" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
