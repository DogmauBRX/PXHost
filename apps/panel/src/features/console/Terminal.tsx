import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onReady: (term: XTerm) => void;
  disabled?: boolean;
}

// disableStdin: true (architecture doc 5.2) — xterm never captures
// keyboard input directly, so console text is never accidentally typed
// into the terminal's own (invisible) input buffer; commands go through
// the separate <input> in PowerConsoleBar instead, which keeps this
// translatable and accessible.
export function Terminal({ onReady, disabled }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      disableStdin: true,
      convertEol: true,
      fontFamily: '"Fragment Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#161d22',
        foreground: '#e7edef',
        cursor: '#57b5a0',
        selectionBackground: '#17302b',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    onReady(term);

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="xterm-wrapper h-full w-full overflow-hidden rounded-lg border border-border bg-surface p-2"
      aria-label="Console do servidor"
      aria-disabled={disabled}
      ref={containerRef}
    />
  );
}
