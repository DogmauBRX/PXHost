import { useEffect } from 'react';

interface SeoProps {
  title: string;
  description: string;
  /** Path only (e.g. "/plans/starter") — the canonical/OG URL is built from the browser's own origin, since this SPA has no separate build-time knowledge of the deployment's public domain. */
  path?: string;
}

/** Finds (or creates) a `<meta>` tag keyed by `attr="key"` and sets its content — `attr` is `'name'` for description/robots-style tags, `'property'` for Open Graph's `og:*` tags. */
function setMetaTag(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(url: string): void {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = url;
}

/**
 * Minimal client-side SEO for the public commercial site (`/`, `/plans`,
 * `/plans/:slug`) — this SPA has no server-side rendering, so this is
 * the ceiling of what's achievable without one (see the commercial
 * plan's own "SEO tem teto" note): Google renders JS and reads this
 * fine, but a crawler that does NOT execute JS (most link-preview bots —
 * WhatsApp, Discord, Slack, Twitter) only ever sees `index.html`'s
 * static fallback meta tags, never these per-page ones. Authenticated
 * panel routes never render this component and keep the app's static
 * default title.
 */
export function Seo({ title, description, path }: SeoProps) {
  useEffect(() => {
    const fullTitle = `${title} · PXHost`;
    const url = `${window.location.origin}${path ?? window.location.pathname}`;

    document.title = fullTitle;
    setMetaTag('name', 'description', description);
    setMetaTag('property', 'og:title', fullTitle);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:url', url);
    setMetaTag('property', 'og:type', 'website');
    setCanonical(url);
  }, [title, description, path]);

  return null;
}
