import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const variantClasses: Record<Variant, string> = {
  // text-accent-contrast, not text-bg: on the light palette --color-bg is
  // #f6f7f9, which lands at ~3.9:1 against the orange fill — under AA for
  // body-size text. accent-contrast is pure white on light, near-black on
  // dark, so the label stays legible in both.
  primary: 'bg-accent text-accent-contrast shadow-xs hover:bg-accent-strong disabled:opacity-50',
  secondary: 'bg-surface text-text border border-border shadow-xs hover:bg-surface-2 hover:border-border-strong disabled:opacity-50',
  danger: 'bg-fail text-accent-contrast shadow-xs hover:brightness-110 disabled:opacity-50',
  ghost: 'text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 px-3 text-[0.8125rem]',
  md: 'h-10 px-4 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = 'secondary', size = 'md', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
