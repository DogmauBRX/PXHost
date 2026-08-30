import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
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
}

export function Input({ invalid, className = '', ...props }: InputProps) {
  return <input className={`${controlClasses} h-10 ${invalid ? invalidClasses : ''} ${className}`} {...props} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className = '', ...props }: TextareaProps) {
  return <textarea className={`${controlClasses} resize-y py-2.5 ${invalid ? invalidClasses : ''} ${className}`} {...props} />;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ invalid, className = '', children, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        className={`${controlClasses} h-10 cursor-pointer appearance-none pr-9 ${invalid ? invalidClasses : ''} ${className}`}
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
