import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Label + control + hint/error, so every form on every page spaces and
 * announces them the same way. `error` replaces `hint` when present rather
 * than stacking, keeping the row height stable as validation comes and goes.
 */
export function Field({ label, htmlFor, hint, error, required, className = '', children }: FieldProps) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
        {required && <span className="ml-0.5 text-fail">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-fail">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-faint">{hint}</p>
      ) : null}
    </div>
  );
}
