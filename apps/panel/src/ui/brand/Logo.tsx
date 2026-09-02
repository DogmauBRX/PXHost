/**
 * The PXHost mark: a hexagonal "node" — the product's own vocabulary for a
 * hosting machine ("demo-node-1", etc.) made literal as the emblem shape.
 * Gradient-filled diagonally in the brand accent, with fine corner ticks
 * (a circuit-trace detail) and a small status pulse standing in for "a
 * server, online." Every color is a CSS custom property, so it repaints
 * correctly across light/dark without a second asset — see favicon.svg
 * for the one place that genuinely can't reach those variables (a
 * browser tab icon is loaded outside the document's own cascade) and
 * carries hardcoded equivalents instead.
 */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="pxhost-mark-grad" x1="3.5" y1="2" x2="28.5" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--color-accent)" />
          <stop offset="100%" stopColor="var(--color-accent-strong)" />
        </linearGradient>
      </defs>

      {/* Outer node hexagon */}
      <path d="M16 1.8 28.4 9v14L16 30.2 3.6 23V9Z" fill="url(#pxhost-mark-grad)" />

      {/* Nested hex outline — circuit-board layering, kept faint so it reads as detail, not clutter */}
      <path
        d="M16 6.2 23.9 10.6v8.8L16 23.8 8.1 19.4v-8.8Z"
        fill="none"
        stroke="var(--color-accent-contrast)"
        strokeOpacity="0.22"
        strokeWidth="1"
      />

      {/* Corner ticks — short traces reaching out from each vertex */}
      <g stroke="var(--color-accent-contrast)" strokeOpacity="0.4" strokeWidth="1.1" strokeLinecap="round">
        <path d="M16 1.8v2.6M28.4 9l-2.3 1.3M28.4 23l-2.3-1.3M16 30.2v-2.6M3.6 23l2.3-1.3M3.6 9l2.3 1.3" />
      </g>

      {/* P monogram */}
      <text
        x="16"
        y="21.2"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="800"
        fontSize="13.5"
        fill="var(--color-accent-contrast)"
      >
        P
      </text>

      {/* Status pulse — "a node, online" */}
      <circle cx="24.5" cy="8.4" r="2.3" fill="var(--color-ok)" stroke="var(--color-surface)" strokeWidth="1.2" />
    </svg>
  );
}
