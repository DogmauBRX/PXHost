import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

/**
 * `TableWrap` scrolls HORIZONTALLY only, on purpose. The redesign removed
 * the nested vertical scroll containers that were trapping page content in
 * short strips; a wide table still needs somewhere to go on a narrow screen,
 * and sideways is the one direction that doesn't recreate the box-inside-a-
 * box problem.
 */
export function TableWrap({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`overflow-x-auto rounded-card border border-border bg-surface shadow-xs ${className}`} {...props} />;
}

export function Table({ className = '', ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={`w-full border-collapse text-sm ${className}`} {...props} />;
}

export function THead({ className = '', ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={`border-b border-border bg-surface-2/60 ${className}`} {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className = '', ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`border-b border-border transition-colors last:border-0 hover:bg-surface-2/60 ${className}`} {...props} />;
}

export function TH({ className = '', ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold tracking-wide text-text-muted uppercase ${className}`}
      {...props}
    />
  );
}

export function TD({ className = '', ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-4 py-3 align-middle text-text ${className}`} {...props} />;
}
