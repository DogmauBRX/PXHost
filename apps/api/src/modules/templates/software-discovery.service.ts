import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../core/redis/redis.service';
import type { PresetKind } from './software-presets';

const CACHE_TTL_SECONDS = 600; // 10 min — the same public projects rarely cut a new release/build more than once in that window, and this is an admin convenience, not a customer-facing catalog.
const FETCH_TIMEOUT_MS = 8000;

/**
 * Live version/build lookups for the "criação rápida" wizard's Etapa 2/3
 * (Admin Templates redesign) — the same public APIs each preset's own
 * install script (`software-presets.ts`) already calls at container-boot
 * time to resolve "latest", queried here up front so the admin can pick
 * from a real list instead of typing a version number blind.
 *
 * Every method degrades to `[]` on ANY failure — a malformed response, a
 * timeout, the upstream API being down, a shape change nobody anticipated
 * — never throws. The wizard's own fallback for `[]` is a free-text
 * field, so a third-party outage never blocks creating a template; it
 * just means the admin types "latest" themselves, exactly as they always
 * could. Same posture `PublicStatusService`/`AgentClient` already take
 * with external dependencies this codebase doesn't control.
 */
@Injectable()
export class SoftwareDiscoveryService {
  private readonly logger = new Logger(SoftwareDiscoveryService.name);

  constructor(private readonly redis: RedisService) {}

  async getVersions(kind: PresetKind): Promise<string[]> {
    switch (kind) {
      case 'paper':
        return this.cached('paper:versions', () => this.fetchPaperVersions());
      case 'purpur':
        return this.cached('purpur:versions', () => this.fetchPurpurVersions());
      case 'fabric':
        return this.cached('fabric:versions', () => this.fetchFabricGameVersions());
      case 'quilt':
        return this.cached('quilt:versions', () => this.fetchQuiltGameVersions());
      case 'vanilla':
        return this.cached('vanilla:versions', () => this.fetchVanillaVersions());
      case 'forge':
        return this.cached('forge:versions', () => this.fetchForgeVersions());
      case 'neoforge':
        return this.cached('neoforge:versions', () => this.fetchNeoForgeVersions());
    }
  }

  /** `mcVersion` is ignored for `fabric` (the loader list isn't scoped to a Minecraft version) and for `vanilla` (no second tier at all — always `[]`). */
  async getBuilds(kind: PresetKind, mcVersion: string): Promise<string[]> {
    switch (kind) {
      case 'paper':
        return this.cached(`paper:builds:${mcVersion}`, () => this.fetchPaperBuilds(mcVersion));
      case 'purpur':
        return this.cached(`purpur:builds:${mcVersion}`, () => this.fetchPurpurBuilds(mcVersion));
      case 'fabric':
        return this.cached('fabric:loaders', () => this.fetchFabricLoaderVersions());
      case 'quilt':
        return this.cached('quilt:loaders', () => this.fetchQuiltLoaderVersions());
      case 'forge':
        return this.cached(`forge:builds:${mcVersion}`, () => this.fetchForgeBuildsFor(mcVersion));
      case 'neoforge':
        return this.cached(`neoforge:builds:${mcVersion}`, () => this.fetchNeoForgeBuildsFor(mcVersion));
      case 'vanilla':
        return [];
    }
  }

  private async cached(key: string, fetcher: () => Promise<string[]>): Promise<string[]> {
    const cacheKey = `template-discovery:${key}`;
    const hit = await this.redis.client.get(cacheKey).catch(() => null);
    if (hit !== null) {
      try {
        return JSON.parse(hit) as string[];
      } catch {
        // fall through and re-fetch — a corrupted cache entry is never worth failing over
      }
    }

    let result: string[];
    try {
      result = await fetcher();
      if (!Array.isArray(result)) result = [];
    } catch (err) {
      this.logger.warn(`software discovery fetch failed for "${key}": ${(err as Error).message}`);
      result = [];
    }

    await this.redis.client.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'gxhost-hosting-panel/0.1.0' } });
      if (!res.ok) throw new Error(`${url} responded ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- Paper (migrated off the sunset api.papermc.io/v2 — found live
  // 2026-09-16 returning {"ok":false,"error":"sunset"} for every call,
  // meaning `getVersions('paper')`/`getBuilds('paper', ...)` had been
  // silently degrading to `[]` this whole time, per this class's own
  // "never throw" posture. fill.papermc.io/v3 is the real successor.) ----

  private async fetchPaperVersions(): Promise<string[]> {
    // {"project":{...},"versions":{"1.21":["1.21.4","1.21.3",...],"1.20":[...],...}}
    // — grouped by minor version, groups AND entries within a group are
    // already newest-first, so flattening preserves that ordering.
    const data = (await this.fetchJson('https://fill.papermc.io/v3/projects/paper')) as { versions?: unknown };
    if (!data.versions || typeof data.versions !== 'object') return [];
    return Object.values(data.versions as Record<string, unknown>)
      .flatMap((group) => (Array.isArray(group) ? group : []))
      .filter((v): v is string => typeof v === 'string');
  }

  private async fetchPaperBuilds(mcVersion: string): Promise<string[]> {
    // [{"id":232,"time":...,"channel":"STABLE",...}, ...] — newest-first already.
    const data = await this.fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`);
    if (!Array.isArray(data)) return [];
    return data.filter((b): b is { id: number } => typeof b?.id === 'number').map((b) => String(b.id));
  }

  // ---- Purpur (still on the original "/v2/purpur[/<version>]" API) ----

  private async fetchPurpurVersions(): Promise<string[]> {
    const data = (await this.fetchJson('https://api.purpurmc.org/v2/purpur')) as { versions?: unknown };
    const versions = Array.isArray(data.versions) ? data.versions.filter((v): v is string => typeof v === 'string') : [];
    return versions.reverse(); // API lists oldest-first; newest-first reads better as wizard suggestions
  }

  private async fetchPurpurBuilds(mcVersion: string): Promise<string[]> {
    const data = (await this.fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}`)) as {
      builds?: { all?: unknown };
    };
    const all = Array.isArray(data.builds?.all) ? data.builds.all.filter((b): b is string => typeof b === 'string') : [];
    return all.reverse();
  }

  // ---- Fabric ----

  private async fetchStableVersionList(url: string): Promise<string[]> {
    const data = (await this.fetchJson(url)) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry): entry is { version: string; stable: boolean } => typeof entry?.version === 'string' && entry?.stable === true)
      .map((entry) => entry.version);
  }

  private fetchFabricGameVersions(): Promise<string[]> {
    return this.fetchStableVersionList('https://meta.fabricmc.net/v2/versions/game');
  }

  private fetchFabricLoaderVersions(): Promise<string[]> {
    return this.fetchStableVersionList('https://meta.fabricmc.net/v2/versions/loader');
  }

  // ---- Quilt ----

  private fetchQuiltGameVersions(): Promise<string[]> {
    return this.fetchStableVersionList('https://meta.quiltmc.org/v3/versions/game');
  }

  private async fetchQuiltLoaderVersions(): Promise<string[]> {
    const data = await this.fetchJson('https://meta.quiltmc.org/v3/versions/loader');
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry): entry is { version: string } => typeof entry?.version === 'string')
      .map((entry) => entry.version)
      .filter((version) => !/-(?:alpha|beta|rc)/i.test(version));
  }

  // ---- Vanilla ----

  private async fetchVanillaVersions(): Promise<string[]> {
    const data = (await this.fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json')) as {
      versions?: unknown;
    };
    if (!Array.isArray(data.versions)) return [];
    // Newest-first already, per Mojang's own manifest ordering — release
    // builds only, same filter the install script effectively applies by
    // reading `.latest.release` rather than `.latest.snapshot`.
    return data.versions
      .filter((v): v is { id: string; type: string } => typeof v?.id === 'string' && v?.type === 'release')
      .map((v) => v.id);
  }

  // ---- Forge ----

  private async fetchForgePromotions(): Promise<Record<string, string>> {
    const data = (await this.fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')) as {
      promos?: unknown;
    };
    return data.promos && typeof data.promos === 'object' ? (data.promos as Record<string, string>) : {};
  }

  private async fetchForgeVersions(): Promise<string[]> {
    const promos = await this.fetchForgePromotions();
    const versions = new Set<string>();
    for (const key of Object.keys(promos)) {
      const match = /^([0-9.]+)-(recommended|latest)$/.exec(key);
      if (match) versions.add(match[1]);
    }
    return [...versions].sort(compareVersionsDesc);
  }

  private async fetchForgeBuildsFor(mcVersion: string): Promise<string[]> {
    const promos = await this.fetchForgePromotions();
    const values = [promos[`${mcVersion}-recommended`], promos[`${mcVersion}-latest`]].filter(
      (v, i, arr): v is string => typeof v === 'string' && arr.indexOf(v) === i,
    );
    return values;
  }

  // ---- NeoForge (version numbers ENCODE the Minecraft version they
  // target, but not consistently enough to reverse safely — see
  // fetchNeoForgeVersions's own doc comment for why the version LIST
  // cross-references Vanilla's instead of parsing this. fetchNeoForgeReleaseVersions
  // itself is still needed as-is for fetchNeoForgeBuildsFor's exact/prefix
  // match against a Minecraft version the caller already picked.) ----

  private async fetchNeoForgeReleaseVersions(): Promise<string[]> {
    const data = (await this.fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')) as {
      versions?: unknown;
    };
    return Array.isArray(data.versions) ? data.versions.filter((v): v is string => typeof v === 'string') : [];
  }

  // NeoForge forked from Forge at Minecraft 1.20.1 — its oldest real
  // release ever, and the floor this scopes Vanilla's own list down to.
  private static readonly NEOFORGE_OLDEST_MINECRAFT_VERSION = '1.20.1';

  /**
   * Deriving "which Minecraft version does this NeoForge release target"
   * from the release string alone isn't safe: the pre-2026 scheme is
   * "<mc-minor>.<mc-patch>.<build>" (needs a "1." prefix restored, e.g.
   * "20.4.80" -> Minecraft 1.20.4), but the newer bare-year scheme adds
   * one more segment for the Minecraft PATCH itself, without a trailing
   * ".0" when that patch is 0 (e.g. "26.1.2.71" -> Minecraft "26.1.2",
   * while "26.2.0.57" -> "26.2", not "26.2.0") — guessing which segments
   * are "Minecraft version" vs "NeoForge's own patch/build" from the
   * string alone produced actively wrong output before this (found live:
   * "1.26.3", a version that never existed, and "1.0.25w14craftmine"
   * from one of NeoForge's own April Fools joke releases leaking
   * through). Cross-referencing against `fetchVanillaVersions` — which
   * this class already gets right, straight from Mojang's own manifest —
   * sidesteps parsing NeoForge's scheme at all: every version NeoForge
   * could possibly target is already a real Vanilla release, so this
   * just scopes that same, already-correct list down to NeoForge's
   * actual supported range.
   */
  private async fetchNeoForgeVersions(): Promise<string[]> {
    const vanillaVersions = await this.fetchVanillaVersions();
    const cutoffIndex = vanillaVersions.indexOf(SoftwareDiscoveryService.NEOFORGE_OLDEST_MINECRAFT_VERSION);
    return cutoffIndex === -1 ? vanillaVersions : vanillaVersions.slice(0, cutoffIndex + 1);
  }

  private async fetchNeoForgeBuildsFor(mcVersion: string): Promise<string[]> {
    // Reverses fetchNeoForgeVersions' own "1." + prefix display mapping —
    // "1.20.4" -> prefix "20.4" — to filter the release list back down.
    const prefix = mcVersion.startsWith('1.') ? mcVersion.slice(2) : mcVersion;
    const releases = await this.fetchNeoForgeReleaseVersions();
    return releases.filter((v) => v === prefix || v.startsWith(`${prefix}.`)).sort(compareVersionsDesc);
  }
}

/** Best-effort numeric-aware version compare (`"1.21.4" > "1.9.0"`), newest first — falls back to plain string compare for anything non-numeric rather than throwing. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (Number.isNaN(na) || Number.isNaN(nb)) return b.localeCompare(a);
    if (na !== nb) return nb - na;
  }
  return 0;
}
