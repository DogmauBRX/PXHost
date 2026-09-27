import type { CurseForgeProjectMeta } from '../plugins/curseforge.provider';

// Forge/NeoForge's missing/mismatched-dependency report, one line per
// broken dependency, e.g.:
//   Mod §ecolorwheel§r requires §6oculus§r §o1.7.0 or above§r
// Matched after formatting codes are stripped (see stripFormatting).
const MISSING_DEPENDENCY = /Mod\s+([a-z0-9_.-]+)\s+requires\s+([a-z0-9_.-]+)/gi;

// Forge reports a per-mod lifecycle failure in more than one wording
// depending on which phase it happened in, all following the same
// "Name (modid) <phrase>" shape, cause on the next line:
//   Sodium Extras (sodiumextras) has failed to load correctly
//   §7java.lang.RuntimeException: Attempted to load class net/minecraft/client/Options for invalid dist DEDICATED_SERVER
//   Distant Horizons (distanthorizons) encountered an error during the sided_setup event phase
//   §7java.lang.NullPointerException: Cannot invoke "…IMinecraftClientWrapper.crashMinecraft(…)" because "…MC_CLIENT" is null
const MOD_FAILED = /^\s*(.*?)\s*\(([a-z0-9_.-]+)\)\s+(?:has failed to load correctly|encountered an error during the \S+ event phase)/i;

function stripFormatting(text: string): string {
  return text.replace(/§./g, '');
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Decides which CurseForge projects to additionally skip on the next
 * automatic retry of a failed install, from the Agent's boot-failure text.
 * Returns only projects that aren't already skipped; an empty result means
 * this failure isn't one a retry can fix.
 *
 * Two failure shapes are handled, with deliberately different rules:
 *
 * - "Mod X requires Y" where Y is something we skipped: X can't load
 *   without it, so X is skipped too — along with anything that itself
 *   requires X, since it would fail the same way next round.
 *
 * - "X has failed to load correctly" / "X encountered an error during the
 *   <phase> event phase" (Forge's wording depends on which lifecycle phase
 *   failed): X is skipped ONLY if no project that
 *   stays installed declares it as a required dependency. Forge lists
 *   cascade victims in the same failure block — found live 2026-09-27:
 *   Framework appeared there with a client-class error of its own, but four
 *   server-side mods genuinely needed it, and removing it broke the server
 *   outright. A mod others depend on is never assumed to be the culprit.
 *   The cause itself isn't required to name client code: on the same pack,
 *   ItemPhysicLite failed with a bare ExceptionInInitializerError, which a
 *   client-code rule would never skip, leaving the server unbootable every
 *   attempt. A mod nothing else needs that stops the server from booting at
 *   all is safer gone than present.
 *
 * Forge mod ids aren't CurseForge ids; a project is matched by slug or
 * display name (compared ignoring punctuation), or failing that by the jar
 * name starting with the mod id.
 */
export function planCurseForgeRetrySkips(
  errorMessage: string,
  meta: Record<number, CurseForgeProjectMeta>,
  alreadySkipped: Iterable<number>,
): number[] {
  const text = stripFormatting(errorMessage);
  const excluded = new Set(alreadySkipped);
  const projectIds = Object.keys(meta).map(Number);

  const lookup = (modId: string, displayName?: string): number | undefined => {
    const wanted = [modId, displayName].filter((label): label is string => Boolean(label)).map(normalize).filter(Boolean);
    const byLabel = projectIds.find((id) => wanted.includes(normalize(meta[id].slug)) || wanted.includes(normalize(meta[id].name)));
    if (byLabel !== undefined) return byLabel;
    // Fall back to the jar name, which conventionally starts with the mod id.
    // The id must end at a separator so "create" never claims
    // "createbetterfps-…jar"; ambiguous matches are refused.
    const id = modId.toLowerCase();
    const byFile = projectIds.filter((projectId) => {
      const file = meta[projectId].filename?.toLowerCase();
      return Boolean(file?.startsWith(id)) && !/[a-z]/.test(file!.charAt(id.length));
    });
    return byFile.length === 1 ? byFile[0] : undefined;
  };

  const newSkips = new Set<number>();

  // Missing dependency on something we skipped.
  for (const [, complaining, missing] of text.matchAll(MISSING_DEPENDENCY)) {
    const missingId = lookup(missing);
    if (missingId === undefined || !excluded.has(missingId)) continue; // not caused by our own skip
    const complainingId = lookup(complaining);
    if (complainingId === undefined || excluded.has(complainingId)) continue;
    newSkips.add(complainingId);
  }
  // Anything requiring a newly skipped project fails the same way next round.
  let changed = newSkips.size > 0;
  while (changed) {
    changed = false;
    for (const id of projectIds) {
      if (excluded.has(id) || newSkips.has(id)) continue;
      if (meta[id].requires.some((dep) => newSkips.has(dep))) {
        newSkips.add(id);
        changed = true;
      }
    }
  }

  // Mods Forge reports as failed, whichever lifecycle phase it happened in.
  const candidates = new Set<number>();
  for (const line of text.split('\n')) {
    const match = MOD_FAILED.exec(line);
    if (!match) continue;
    const id = lookup(match[2], match[1]);
    if (id !== undefined && !excluded.has(id) && !newSkips.has(id)) candidates.add(id);
  }
  const kept = projectIds.filter((id) => !excluded.has(id) && !newSkips.has(id) && !candidates.has(id));
  for (const id of candidates) {
    if (kept.some((keptId) => meta[keptId].requires.includes(id))) continue; // possible cascade victim
    newSkips.add(id);
  }

  return [...newSkips];
}
