/**
 * Byte-size and date/time formatters shared across the panel — extracted
 * from per-page copies that had drifted into ~9 near-identical local
 * `formatDate`/`formatBytes` functions. Each helper here reproduces one of
 * those copies' exact output (this is a de-duplication, not a reformat);
 * callers with null-handling around the date keep that logic locally and
 * just call the matching formatter for the non-null case.
 */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Locale-default date+time, no style options — e.g. "05/09/2026, 21:50:23". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

/** `dateStyle: 'short', timeStyle: 'short'` — e.g. "05/09/26, 21:50". */
export function formatDateTimeShort(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** `dateStyle: 'short', timeStyle: 'medium'` — short date, time with seconds. */
export function formatDateTimeMedium(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

/** Date only, no time — `toLocaleDateString('pt-BR')`. */
export function formatDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR');
}
