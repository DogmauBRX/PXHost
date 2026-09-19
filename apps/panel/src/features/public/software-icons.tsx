import { Box, FileText, Flame, Grape, Hammer, HelpCircle, Network, Package, Shirt, Wrench, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PublicTemplate } from '@/shared/api/types';

interface SoftwareIconSpec {
  icon: LucideIcon;
  toneClass: string;
}

// Decorative variety only — tones cycle through the app's existing
// semantic tokens (accent/ok/warn/high/info/neutral, index.css) purely so
// the checkout's software grid isn't a wall of identical squares. They
// carry NO meaning here: a "warn"-tinted Spigot icon is not a warning.
// `fail` (red, already used for crashed/suspended server states
// elsewhere) is deliberately never used — a red square next to the
// others would misread as "something's wrong with this option".
const SOFTWARE_ICONS: Record<string, SoftwareIconSpec> = {
  vanilla: { icon: Box, toneClass: 'bg-accent-tint text-accent-strong' },
  paper: { icon: FileText, toneClass: 'bg-ok-tint text-ok' },
  purpur: { icon: Grape, toneClass: 'bg-warn-tint text-warn' },
  spigot: { icon: Wrench, toneClass: 'bg-high-tint text-high' },
  bukkit: { icon: Package, toneClass: 'bg-info-tint text-info' },
  fabric: { icon: Shirt, toneClass: 'bg-surface-2 text-text-muted' },
  quilt: { icon: Package, toneClass: 'bg-info-tint text-info' },
  forge: { icon: Hammer, toneClass: 'bg-accent-tint text-accent-strong' },
  neoforge: { icon: Flame, toneClass: 'bg-ok-tint text-ok' },
  bungeecord: { icon: Network, toneClass: 'bg-warn-tint text-warn' },
  velocity: { icon: Zap, toneClass: 'bg-high-tint text-high' },
};
const FALLBACK_ICON: SoftwareIconSpec = { icon: HelpCircle, toneClass: 'bg-surface-2 text-text-muted' };

/**
 * A software's visual identity on the checkout's software grid
 * (`ConfigureStep`'s "② Versão do sistema" section in CheckoutPage.tsx).
 *
 * `template.iconUrl` wins whenever an admin sets one (a real brand logo,
 * via `/admin/templates` — not built yet, but the field already exists on
 * `Template`/`PublicTemplate`) — otherwise falls back to a bundled lucide
 * glyph picked by `softwareKind`.
 *
 * HONEST CAVEAT: the bundled glyphs below are lucide icons chosen loosely
 * by association (forge → hammer, bungeecord → network, purpur → grape
 * for the color pun) — they are NOT the official Paper/Purpur/Fabric/
 * Forge logos. Those are third-party marks this repository does not
 * ship. The real-logo path is `iconUrl` above, which always takes
 * priority when an admin sets it.
 */
export function SoftwareIcon({
  template,
  className = 'h-10 w-10',
}: {
  template: Pick<PublicTemplate, 'iconUrl' | 'softwareKind' | 'name'>;
  className?: string;
}) {
  if (template.iconUrl) {
    return <img src={template.iconUrl} alt="" className={`${className} shrink-0 rounded-lg object-cover`} />;
  }
  const spec = (template.softwareKind && SOFTWARE_ICONS[template.softwareKind]) || FALLBACK_ICON;
  const Icon = spec.icon;
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${spec.toneClass} ${className}`}>
      <Icon className="h-1/2 w-1/2" aria-hidden="true" />
    </span>
  );
}
