import { useId } from 'react';

/**
 * GXhost's compact mark. The graphite core represents the control panel,
 * while the split orange frame and the online node turn the old generic
 * hexagon into a recognisable infrastructure badge. The GX monogram is
 * drawn with paths so it stays consistent even before web fonts load.
 */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  const gradientId = `gx-frame-${useId().replace(/:/g, '')}`;
  const glowId = `gx-glow-${useId().replace(/:/g, '')}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={`brand-mark ${className}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="7" y1="5" x2="41" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffb066" />
          <stop offset="0.42" stopColor="var(--color-accent)" />
          <stop offset="1" stopColor="#b63808" />
        </linearGradient>
        <radialGradient id={glowId} cx="0" cy="0" r="1" gradientTransform="translate(24 24) rotate(90) scale(19)">
          <stop stopColor="#303640" />
          <stop offset="1" stopColor="#12151a" />
        </radialGradient>
      </defs>

      <path
        className="brand-mark__frame"
        d="M24 2.4 42.5 13v22L24 45.6 5.5 35V13Z"
        fill={`url(#${gradientId})`}
      />
      <path d="M24 6.8 38.7 15.2v17.6L24 41.2 9.3 32.8V15.2Z" fill={`url(#${glowId})`} />
      <path
        d="M24 7.5 38 15.6v16.8L24 40.5 10 32.4V15.6Z"
        fill="none"
        stroke="white"
        strokeOpacity="0.12"
        strokeWidth="0.8"
      />

      <g className="brand-mark__monogram" fill="none" strokeLinecap="square" strokeLinejoin="miter">
        <path
          d="M26.1 17.2h-5.2a6.8 6.8 0 1 0 0 13.6h5.5v-5.3h-4.7"
          stroke="#f8f4ee"
          strokeWidth="3.1"
        />
        <path d="m29.2 19.1 6.1 9.8m0-9.8-6.1 9.8" stroke={`url(#${gradientId})`} strokeWidth="2.7" />
      </g>

      <path d="M6.2 15.3h3.2M38.6 32.7h3.2" stroke="#ffd0a5" strokeOpacity="0.75" strokeWidth="1" />
      <circle className="brand-mark__status-halo" cx="38.3" cy="10.5" r="4" fill="#34d399" fillOpacity="0.16" />
      <circle className="brand-mark__status" cx="38.3" cy="10.5" r="2.1" fill="#5ee6a4" stroke="#15181e" strokeWidth="1.1" />
    </svg>
  );
}
