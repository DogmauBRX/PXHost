import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ---- Spinner / Skeleton ---- */

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-text-faint ${className}`} aria-hidden="true" />;
}

export function LoadingRow({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
      <Spinner />
      {label}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
}

/* ---- Alert ---- */

type Tone = 'fail' | 'warn' | 'ok' | 'info';

const toneMap: Record<Tone, { icon: LucideIcon; classes: string }> = {
  fail: { icon: AlertCircle, classes: 'bg-fail-tint text-fail border-fail/25' },
  warn: { icon: TriangleAlert, classes: 'bg-warn-tint text-warn border-warn/25' },
  ok: { icon: CheckCircle2, classes: 'bg-ok-tint text-ok border-ok/25' },
  info: { icon: Info, classes: 'bg-info-tint text-info border-info/25' },
};

interface AlertProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function Alert({ tone = 'fail', title, children, onDismiss, className = '' }: AlertProps) {
  const { icon: Icon, classes } = toneMap[tone];
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${classes} ${className}`} role="alert">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dispensar" className="-m-1 shrink-0 rounded p-1 hover:opacity-70">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/* ---- EmptyState ---- */

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-border bg-surface px-6 py-14 text-center">
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2">
          <Icon className="h-5 w-5 text-text-faint" aria-hidden="true" />
        </div>
      )}
      <p className="text-sm font-medium text-text">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
