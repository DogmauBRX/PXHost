import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-accent text-bg hover:bg-accent-strong disabled:opacity-50',
  secondary: 'bg-surface-2 text-text border border-border hover:border-border-strong disabled:opacity-50',
  danger: 'bg-fail-tint text-fail border border-fail/30 hover:bg-fail hover:text-bg disabled:opacity-50',
  ghost: 'text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
