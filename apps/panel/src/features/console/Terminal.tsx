import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { readToken } from '@/shared/theme/tokens';
import { THEME_CHANGE_EVENT } from '@/shared/theme/theme.store';

interface TerminalProps {
  onReady: (term: XTerm) => void;
  disabled?: boolean;
}

/**
 * The terminal stays dark in both themes.
 *
 * That is deliberate, not an oversight: game-server output is ANSI-coloured
 * for a dark background, and the default bright ANSI ramp (yellow, cyan) is
 * close to unreadable on white. Every comparable product — Pterodactyl,
 * Cloudways — keeps a dark console inside a light panel for the same reason.
 * Only the accent (cursor/selection) follows the theme, so the terminal still
 * reads as part of the product.
 */
function buildTheme(): ITheme {
  return {
    background: '#12161b',
    foreground: '#e8ebef',
    cursor: readToken('--color-accent') || '#ea580c',
    selectionBackground: '#2a3038',
    black: '#12161b',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d8de',
    brightBlack: '#6e7887',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff',
  };
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
      fontFamily: readToken('--font-mono') || '"Fragment Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: buildTheme(),
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

    // xterm can swap its palette in place, so this needs no teardown — and
    // listens to a DOM event rather than React state so the streaming path
    // never re-renders (see THEME_CHANGE_EVENT's own doc comment).
    const onThemeChange = () => {
      if (termRef.current) termRef.current.options.theme = buildTheme();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="xterm-wrapper h-full w-full overflow-hidden rounded-card border border-border bg-[#12161b] p-2 shadow-xs"
      aria-label="Console do servidor"
      aria-disabled={disabled}
      ref={containerRef}
    />
  );
}
