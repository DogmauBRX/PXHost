import { useEffect, useId, useRef } from 'react';

// The public Site Key only (safe in a browser bundle by design — same
// posture the panel uses for every public build-time key). The
// matching Secret Key is a server-side value in apps/api/.env
// (TURNSTILE_SECRET_KEY), never here. Read once at module scope: when
// unset, every consumer of this component below just renders nothing
// and the forms submit without a token — TurnstileService on the
// backend treats an unconfigured deployment identically (skips
// verification entirely), so dev/test never needs a Cloudflare account.
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
let scriptPromise: Promise<void> | null = null;

// Loads the Turnstile script at most once per page, however many
// <Turnstile> instances mount (a visitor could have both a login form
// and, briefly, a stale register form in the tree during a route
// transition) — module-scoped so a second mount reuses the first's
// in-flight load instead of racing a duplicate <script> tag.
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Turnstile script'));
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

/**
 * Cloudflare Turnstile widget — renders nothing when
 * `VITE_TURNSTILE_SITE_KEY` isn't set (see that constant's own comment),
 * so every call site can render this unconditionally rather than
 * wrapping it in its own env check. `onVerify` fires with the token to
 * send as `captchaToken`; `TurnstileService` on the backend re-verifies
 * it server-side before the request does anything real — this widget is
 * a UX/first line of defense, never the actual security boundary.
 */
export function Turnstile({ onVerify }: { onVerify: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;

    void loadTurnstileScript().then(() => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: onVerify,
        'expired-callback': () => onVerify(''),
        'error-callback': () => onVerify(''),
      });
    });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onVerify is expected to be stable per mount (a fresh setState function), re-rendering the widget on every parent render would reset the challenge for no reason.
  }, []);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={containerRef} id={`turnstile-${id}`} />;
}
