// The canonical software→addon-directory map. A pure module with no Nest
// DI, so both `servers` (response projection) and `assistant` (guidance
// text) import it directly without a module dependency between them.
//
// This is deliberately the ONE place the strings "plugins"/"mods" and
// their directory meaning exist in the whole system. Every place that
// tells a customer where to put a file — the Add-ons page's label, its
// guidance banner, the assistant's install-mods/install-plugins topics —
// reads from `describeSoftware()` rather than hardcoding a path, which is
// what makes "never give software-incompatible instructions" a property
// of the data instead of a promise kept by convention across N files.

export const SOFTWARE_KINDS = [
  'paper',
  'purpur',
  'spigot',
  'bukkit',
  'fabric',
  'forge',
  'neoforge',
  'vanilla',
  'bungeecord',
  'velocity',
  'other',
] as const;

export type SoftwareKind = (typeof SOFTWARE_KINDS)[number];

export interface SoftwareInfo {
  kind: SoftwareKind | null;
  label: string;
  /**
   * Agent-relative, no leading slash — the agent's `fsx.sanitize()` and
   * the panel's own `joinPath()`/breadcrumb logic both treat `.` as root;
   * a leading slash would round-trip fine through the agent (`path.Clean`
   * absorbs it) but would render a phantom empty breadcrumb segment in
   * FileManager. Use `addonDirDisplay` for anything shown to a human.
   */
  addonDir: 'plugins' | 'mods' | null;
  addonDirDisplay: '/plugins' | '/mods' | null;
  addonNoun: 'plugin' | 'mod' | null;
  addonLabel: 'Plugins' | 'Mods' | null;
  isProxy: boolean;
}

const LABELS: Record<SoftwareKind, string> = {
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla',
  bungeecord: 'BungeeCord',
  velocity: 'Velocity',
  other: 'Outro',
};

const PLUGIN_KINDS = new Set<SoftwareKind>(['paper', 'purpur', 'spigot', 'bukkit', 'bungeecord', 'velocity']);
const MOD_KINDS = new Set<SoftwareKind>(['fabric', 'forge', 'neoforge']);
const PROXY_KINDS = new Set<SoftwareKind>(['bungeecord', 'velocity']);

export function describeSoftware(kind: string | null | undefined): SoftwareInfo {
  const known = SOFTWARE_KINDS.includes(kind as SoftwareKind) ? (kind as SoftwareKind) : null;

  if (known && PLUGIN_KINDS.has(known)) {
    return {
      kind: known,
      label: LABELS[known],
      addonDir: 'plugins',
      addonDirDisplay: '/plugins',
      addonNoun: 'plugin',
      addonLabel: 'Plugins',
      isProxy: PROXY_KINDS.has(known),
    };
  }

  if (known && MOD_KINDS.has(known)) {
    return {
      kind: known,
      label: LABELS[known],
      addonDir: 'mods',
      addonDirDisplay: '/mods',
      addonNoun: 'mod',
      addonLabel: 'Mods',
      isProxy: false,
    };
  }

  // vanilla / other / null — no addon guidance available. Distinguish
  // "known to have none" (vanilla/other) from "not classified" (null) via
  // `label`, but both carry no addon directory: neither can be given
  // meaningful mods/plugins instructions.
  return {
    kind: known,
    label: known ? LABELS[known] : 'Desconhecido',
    addonDir: null,
    addonDirDisplay: null,
    addonNoun: null,
    addonLabel: null,
    isProxy: false,
  };
}
