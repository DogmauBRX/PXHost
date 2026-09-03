/**
 * Reads a design token straight off the document element.
 *
 * Most of the UI never needs this — Tailwind resolves `bg-surface` to
 * `var(--color-surface)` and the browser does the work at paint time. But
 * xterm.js takes colors as plain JS strings and cannot read CSS variables
 * at all, so the console page has to hand it concrete values. This is the
 * one sanctioned way to get them, so the terminal stays in sync with the
 * theme instead of hardcoding hexes that silently rot (which is exactly
 * what it did before the redesign).
 */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
