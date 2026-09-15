/**
 * Custom-hostname plan — format/reserved-word policy for a customer-
 * chosen subdomain label (e.g. "survival"). Pure, no I/O, no Prisma —
 * same posture as public-address.ts, kept separate because this file is
 * about what a label is ALLOWED to look like, not how it's composed
 * into a full hostname.
 *
 * Stricter than `Location.shortCode`'s `/^[a-z0-9-]+$/` (which tolerates
 * a leading/trailing hyphen): this value becomes a literal DNS label,
 * where a leading/trailing hyphen is invalid per the DNS spec itself,
 * not just an internal identifier.
 */

export const HOSTNAME_LABEL_MIN_LENGTH = 3;
export const HOSTNAME_LABEL_MAX_LENGTH = 32;

/** Lowercase alphanumeric + internal hyphens only; never starts or ends with a hyphen. */
export const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Fixed subdomains this deployment already uses or is likely to need
 * (docs/DEPLOY.md's node hostnames, common infra names, the existing
 * `.mc.` namespace's own second-level label) — never available for a
 * customer to claim, regardless of what a live DNS lookup would say.
 */
export const RESERVED_HOSTNAME_LABELS = new Set([
  'www',
  'api',
  'admin',
  'mc',
  'node01',
  'node02',
  'mail',
  'ftp',
  'discovery',
  'panel',
  'painel',
  'gxhost',
  'ns1',
  'ns2',
  'autodiscover',
  'status',
  'app',
  'cdn',
  'static',
  'assets',
  'support',
  'billing',
  'root',
  'localhost',
]);

export function isValidHostnameLabelFormat(label: string): boolean {
  return label.length >= HOSTNAME_LABEL_MIN_LENGTH && label.length <= HOSTNAME_LABEL_MAX_LENGTH && HOSTNAME_LABEL_PATTERN.test(label);
}

export function isReservedHostnameLabel(label: string): boolean {
  return RESERVED_HOSTNAME_LABELS.has(label.toLowerCase());
}
