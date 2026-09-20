/**
 * The shared GXhost signature. Splitting GX from host creates a distinctive
 * rhythm without changing the brand name, and lets the monogram and wordmark
 * use the same orange/graphite visual language everywhere in the product.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-wordmark ${className}`} aria-label="GXhost">
      <span className="brand-wordmark__gx" aria-hidden="true">GX</span>
      <span className="brand-wordmark__host" aria-hidden="true">host</span>
    </span>
  );
}
