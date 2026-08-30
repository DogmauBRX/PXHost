import { create } from 'zustand';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'pxhost.theme';

/**
 * Fired on `window` whenever the theme changes.
 *
 * The console page draws into xterm.js and uPlot through refs, never through
 * React state — architecture doc 5.2 requires zero re-renders per second
 * while stats stream. Those two libraries hold copies of the colors they
 * were built with, so they need to be told when the palette changes. A DOM
 * event is how they hear about it without being wired to React state, which
 * would drag them back into the render cycle they were designed to escape.
 */
export const THEME_CHANGE_EVENT = 'pxhost:themechange';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  // Light is the default and lives in @theme itself, so it is expressed as
  // the ABSENCE of the attribute — keeping one source of truth for "light"
  // instead of a [data-theme="light"] block that would have to be kept in
  // sync with the @theme defaults.
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / blocked storage: the theme still applies for this
    // page view, it just won't survive a reload. Not worth surfacing.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

// Read back what the inline script in index.html already applied, so the
// store and the DOM can never disagree on the first render.
function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    apply(theme);
    set({ theme });
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
