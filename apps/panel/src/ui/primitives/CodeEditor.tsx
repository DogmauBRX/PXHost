import { useMemo, useRef, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react';

interface CodeEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown in the header strip — e.g. a filename or `sh`. */
  language?: string;
  spellCheck?: boolean;
  className?: string;
  /** Tailwind height class. Defaults to a large, viewport-relative box. */
  heightClassName?: string;
}

/**
 * A real code field: full width, generous height, monospaced, gutter with
 * line numbers, and Tab that indents instead of escaping the control.
 *
 * This replaces the six-row textarea the install-script field used to be,
 * which was the single worst editing experience in the panel. Deliberately
 * not CodeMirror/Monaco — those add hundreds of kilobytes for syntax
 * colouring that a shell install script barely benefits from. The height is
 * bounded and resizable rather than auto-growing: a 5,000-line file should
 * scroll here, not push every other control off the page.
 */
export function CodeEditor({
  id,
  value,
  onChange,
  placeholder,
  language = 'sh',
  spellCheck = false,
  className = '',
  heightClassName = 'h-[clamp(360px,55vh,720px)]',
}: CodeEditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = useMemo(() => value.split('\n').length, [value]);
  const lines = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1), [lineCount]);

  // Keep the gutter glued to the textarea's scroll position. Done through a
  // ref rather than state so typing in a long script doesn't re-render.
  function handleScroll(e: UIEvent<HTMLTextAreaElement>) {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart, selectionEnd } = el;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    // Restore the caret after React commits the new value.
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 2;
    });
  }

  return (
    <div className={`overflow-hidden rounded-card border border-border bg-field shadow-xs focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 ${className}`}>
      <div className="flex items-center justify-between border-b border-border bg-surface-2/60 px-3 py-1.5">
        <span className="font-mono text-[0.7rem] tracking-wide text-text-muted uppercase">{language}</span>
        <span className="font-mono text-[0.7rem] text-text-faint tabular-nums">
          {lineCount} {lineCount === 1 ? 'linha' : 'linhas'}
        </span>
      </div>
      <div className={`flex ${heightClassName}`}>
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-12 shrink-0 overflow-hidden border-r border-border bg-surface-2/40 py-3 text-right font-mono text-[13px] leading-6 text-text-faint select-none"
        >
          {lines.map((n) => (
            <div key={n} className="px-2 tabular-nums">
              {n}
            </div>
          ))}
        </div>
        <textarea
          id={id}
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={spellCheck}
          wrap="off"
          className="flex-1 resize-none bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-text outline-none placeholder:text-text-faint"
        />
      </div>
    </div>
  );
}
