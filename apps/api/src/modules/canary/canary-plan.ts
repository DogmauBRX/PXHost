export type CanaryAddon =
  | { type: 'plugin'; projectId: string; name: string; dataDir: string }
  | { type: 'modpack'; slugs: string[] };

export interface CanaryScenario {
  softwareKind: string;
  addon: CanaryAddon | null;
  bootTimeoutMs: number;
}

const MIN = 60_000;

// Chunky is stable, tiny, and creates plugins/Chunky/ the moment it is
// enabled — a file-level proof the plugin actually loaded, no log parsing.
const CHUNKY: CanaryAddon = { type: 'plugin', projectId: 'fALzjamp', name: 'Chunky', dataDir: 'plugins/Chunky' };

// Packs are resolved at run time (newest version for the loader), so a pack
// that disappears or drops a loader turns its scenario into "skipped"
// instead of a false alarm.
export const CANARY_SCENARIOS: CanaryScenario[] = [
  { softwareKind: 'paper', addon: CHUNKY, bootTimeoutMs: 5 * MIN },
  { softwareKind: 'purpur', addon: CHUNKY, bootTimeoutMs: 5 * MIN },
  { softwareKind: 'vanilla', addon: null, bootTimeoutMs: 5 * MIN },
  { softwareKind: 'fabric', addon: { type: 'modpack', slugs: ['fabulously-optimized'] }, bootTimeoutMs: 8 * MIN },
  { softwareKind: 'quilt', addon: null, bootTimeoutMs: 8 * MIN },
  { softwareKind: 'forge', addon: null, bootTimeoutMs: 10 * MIN },
  { softwareKind: 'neoforge', addon: null, bootTimeoutMs: 10 * MIN },
];

export interface CanaryNodeTarget {
  nodeId: string;
  nodeName: string;
  planId: string;
}

export interface CanaryAssignment {
  scenario: CanaryScenario;
  templateId: string;
  target: CanaryNodeTarget;
}

/**
 * Each software runs once per night on ONE node, rotating by `offset` so
 * every node eventually runs every software. Node-wide breakage (network,
 * disk, DNS) is the diagnostics check's job; this covers the per-software
 * install/boot/reinstall paths without loading every node with every pack.
 */
export function assignScenarios(
  scenarios: CanaryScenario[],
  templateIdByKind: Map<string, string>,
  targets: CanaryNodeTarget[],
  offset: number,
): { assignments: CanaryAssignment[]; missingTemplates: string[] } {
  const missingTemplates: string[] = [];
  const assignments: CanaryAssignment[] = [];
  if (targets.length === 0) return { assignments, missingTemplates: [] };
  const runnable = scenarios.filter((s) => {
    if (templateIdByKind.has(s.softwareKind)) return true;
    missingTemplates.push(s.softwareKind);
    return false;
  });
  runnable.forEach((scenario, i) => {
    const target = targets[(((i + offset) % targets.length) + targets.length) % targets.length];
    assignments.push({ scenario, templateId: templateIdByKind.get(scenario.softwareKind)!, target });
  });
  return { assignments, missingTemplates };
}

export function dayOffset(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

/** Cheapest public plan this node accepts (unrestricted plans are accepted everywhere). */
export function pickPlanForNode(
  nodeId: string,
  plans: Array<{ id: string; priceCents: number; nodeIds: string[] }>,
): string | null {
  const allowed = plans.filter((p) => p.nodeIds.length === 0 || p.nodeIds.includes(nodeId));
  allowed.sort((a, b) => a.priceCents - b.priceCents);
  return allowed[0]?.id ?? null;
}

/** Newest version that lists the loader, and the newest game version it supports. */
export function pickModpackVersion(
  versions: Array<{ versionId: string; projectId: string; loaders: string[]; minecraftVersions: string[]; publishedAt: string; releaseType: string }>,
  loader: string,
): { versionId: string; projectId: string; minecraftVersion: string } | null {
  const candidates = versions
    .filter((v) => v.loaders.map((l) => l.toLowerCase()).includes(loader) && v.minecraftVersions.length > 0)
    .sort((a, b) => (a.releaseType === 'release' ? 0 : 1) - (b.releaseType === 'release' ? 0 : 1) || b.publishedAt.localeCompare(a.publishedAt));
  const v = candidates[0];
  if (!v) return null;
  return { versionId: v.versionId, projectId: v.projectId, minecraftVersion: v.minecraftVersions[v.minecraftVersions.length - 1] };
}
