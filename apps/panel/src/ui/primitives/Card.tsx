import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Replaces the `rounded-lg border border-border bg-surface p-4` string that
 * was repeated ~57 times across the feature pages. Padding is deliberately
 * NOT baked into `Card` itself — list rows and table shells want an unpadded
 * container — so `CardBody` owns it.
 */
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-card border border-border bg-surface shadow-xs ${className}`} {...props} />;
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex items-start justify-between gap-4 border-b border-border px-5 py-4 ${className}`} {...props} />;
}

export function CardTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-sm font-semibold text-text ${className}`}>{children}</h2>;
}

export function CardDescription({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mt-0.5 text-sm text-text-muted ${className}`}>{children}</p>;
}

export function CardBody({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-5 ${className}`} {...props} />;
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex items-center justify-end gap-2 border-t border-border px-5 py-3 ${className}`} {...props} />;
}
