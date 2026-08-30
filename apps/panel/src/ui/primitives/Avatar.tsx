const sizeClasses = {
  sm: 'h-7 w-7 text-[0.7rem]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
} as const;

interface AvatarProps {
  name?: string | null;
  email?: string | null;
  size?: keyof typeof sizeClasses;
  className?: string;
}

/**
 * Initials only. There is no avatar field anywhere in the API, and inventing
 * a column or reaching out to Gravatar (which leaks an email hash to a third
 * party) would both be worse than deriving two letters locally.
 */
export function Avatar({ name, email, size = 'md', className = '' }: AvatarProps) {
  const source = (name || email || '?').trim();
  const initials = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || source[0]?.toUpperCase() || '?';

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-accent-tint font-semibold text-accent-strong ${sizeClasses[size]} ${className}`}
    >
      {initials}
    </span>
  );
}
