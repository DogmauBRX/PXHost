/**
 * "PXHost" with a continuously sweeping gradient shine — the `.brand-wordmark`
 * class (index.css) owns the gradient, the `background-clip: text` fill,
 * and the shimmer keyframes (including the `prefers-reduced-motion`
 * override), so every usage site gets the identical animated effect for
 * free instead of re-deriving it.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return <span className={`brand-wordmark font-bold tracking-tight ${className}`}>PXHost</span>;
}
