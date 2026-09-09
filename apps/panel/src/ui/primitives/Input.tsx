import type { ComponentType, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * The single source of truth for what a form control looks like. Before
 * this, the literal string below was pasted into ~40 raw <input> elements,
 * which is why focus and error states were inconsistent from page to page.
 */
export const controlClasses =
  'w-full rounded-lg border border-border bg-field px-3 text-sm text-text placeholder:text-text-faint outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60';

const invalidClasses = 'border-fail focus:border-fail focus:ring-fail/20';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Optional leading icon (e.g. a long, field-dense form like checkout/billing) — every other call site simply omits it, so this is additive, not a redesign of every existing input. */
  icon?: ComponentType<{ className?: string }>;
}

export function Input({ invalid, icon: Icon, className = '', ...props }: InputProps) {
  if (!Icon) {
    return <input className={`${controlClasses} h-10 ${invalid ? invalidClasses : ''} ${className}`} {...props} />;
  }
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-faint" aria-hidden="true" />
      <input className={`${controlClasses} h-10 pl-9 ${invalid ? invalidClasses : ''} ${className}`} {...props} />
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className = '', ...props }: TextareaProps) {
  return <textarea className={`${controlClasses} resize-y py-2.5 ${invalid ? invalidClasses : ''} ${className}`} {...props} />;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** Same additive leading icon as Input — omitted everywhere except icon-fronted forms like checkout/billing. */
  icon?: ComponentType<{ className?: string }>;
}

export function Select({ invalid, icon: Icon, className = '', children, ...props }: SelectProps) {
  return (
    <div className="relative">
      {Icon && <Icon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-faint" aria-hidden="true" />}
      <select
        className={`${controlClasses} h-10 cursor-pointer appearance-none pr-9 ${Icon ? 'pl-9' : ''} ${invalid ? invalidClasses : ''} ${className}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-text-faint"
        aria-hidden="true"
      />
    </div>
  );
}
