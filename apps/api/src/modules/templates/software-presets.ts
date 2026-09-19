import type { TemplateVariableDto } from './dto/template.dto';

/**
 * The 6 software choices the admin "criação rápida" wizard offers as
 * cards (Admin Templates redesign) — a strict subset of `SOFTWARE_KINDS`
 * (`software.ts`): every other kind (Spigot, Bukkit, BungeeCord, ...) only
 * exists as manually-configured templates through the advanced form,
 * since nobody asked for a one-click preset for those yet.
 *
 * This is the SAME set `prisma/seed.ts` seeds on a fresh database —
 * `seed.ts` imports `SOFTWARE_PRESETS` from here rather than keeping its
 * own copy of the install scripts, so a customer's "criação rápida"
 * template and a fresh dev database's seeded one are byte-identical,
 * never two hand-maintained versions quietly drifting apart.
 */
export const PRESET_KINDS = ['paper', 'fabric', 'quilt', 'vanilla', 'forge', 'neoforge', 'purpur'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

/**
 * A hand-maintained, hardcoded floor under `SoftwareDiscoveryService`'s
 * live lookups — every version listed here really shipped for that
 * software (never an invented/guessed number), newest first. Two
 * distinct gaps this closes, both found live on a real deployment: (1)
 * `prisma/seed.ts` used to insert every preset with its raw, uncurated
 * `MINECRAFT_VERSION` rule (free-text `required|string|max:16`,
 * `defaultValue: 'latest'`) — a fresh database's client setup screen
 * showed a free-text box until an admin remembered to run "Atualizar
 * versões" at least once. (2) even after that, both the setup screen's
 * own live-discovery fallback (`ServerSetupService.getSetupInfo`) and
 * the admin's "Atualizar versões" action (`TemplatesService.
 * refreshMinecraftVersions`) depended ENTIRELY on a third-party API
 * (fill.papermc.io, launchermeta.mojang.com, ...) answering at that exact
 * moment — any outage meant free text for the customer, or a hard error
 * for the admin, with nothing to fall back to. This list is what both of
 * those now fall back to instead: live data when it's available (still
 * preferred — this list isn't updated as often as the game itself is
 * patched), a real, curated, non-empty list when it isn't.
 *
 * Scoped per software to its actual supported range — NOT the same list
 * copy-pasted across every preset: Fabric and Quilt never shipped for 1.12 or earlier,
 * NeoForge only exists from 1.20.1 onward (it forked FROM Forge at that
 * version), and Paper/Purpur's oldest published builds stop at 1.8.8
 * (one patch behind Vanilla/Forge's 1.8.9, a real difference between
 * those projects' own release histories).
 */
// Every stable release each project actually shipped for, newest first —
// captured from each project's own live API (the same ones
// SoftwareDiscoveryService queries) on 2026-09-18, deliberately excluding
// release-candidate/pre-release/beta builds (unlike a live fetch, a
// hardcoded list has no way to know when an RC gets superseded, so it
// only ever lists genuinely final releases). Scoped per software to what
// it actually supports — see this constant's own doc comment above.
export const KNOWN_MINECRAFT_VERSIONS: Record<PresetKind, string[]> = {
  vanilla: [
    '26.3', '26.2', '26.1.2', '26.1.1', '26.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1', '1.17',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
    '1.13.2', '1.13.1', '1.13',
    '1.12.2', '1.12.1', '1.12',
    '1.11.2', '1.11.1', '1.11',
    '1.10.2', '1.10.1', '1.10',
    '1.9.4', '1.9.3', '1.9.2', '1.9.1', '1.9',
    '1.8.9', '1.8.8', '1.8.7', '1.8.6', '1.8.5', '1.8.4', '1.8.3', '1.8.2', '1.8.1', '1.8',
    '1.7.10', '1.7.9', '1.7.8', '1.7.7', '1.7.6', '1.7.5', '1.7.4', '1.7.3', '1.7.2',
    '1.6.4', '1.6.2', '1.6.1',
    '1.5.2', '1.5.1',
    '1.4.7', '1.4.6', '1.4.5', '1.4.4', '1.4.2',
    '1.3.2', '1.3.1',
    '1.2.5', '1.2.4', '1.2.3', '1.2.2', '1.2.1',
    '1.1', '1.0',
  ],
  paper: [
    '26.3', '26.2', '26.1.2', '26.1.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1', '1.17',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
    '1.13.2', '1.13.1', '1.13',
    '1.12.2', '1.12.1', '1.12',
    '1.11.2', '1.10.2', '1.9.4', '1.8.8', '1.7.10',
  ],
  purpur: [
    '26.3', '26.2', '26.1.2',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
    '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1', '1.17',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2', '1.14.1',
  ],
  fabric: [
    '26.3', '26.2', '26.1.2', '26.1.1', '26.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1', '1.17',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
  ],
  quilt: [
    '26.2', '26.1.2', '26.1.1', '26.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1', '1.17',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
  ],
  forge: [
    '26.2', '26.1.2', '26.1.1', '26.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
    '1.20.6', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4', '1.14.3', '1.14.2',
    '1.13.2',
    '1.12.2', '1.12.1', '1.12',
    '1.11.2', '1.11',
    '1.10.2', '1.10',
    '1.9.4', '1.9',
    '1.8.9', '1.8.8', '1.8',
    '1.7.10', '1.7.2',
    '1.6.4', '1.6.3', '1.6.2', '1.6.1',
    '1.5.2', '1.5.1', '1.5',
    '1.4.7', '1.4.6', '1.4.5', '1.4.4', '1.4.3', '1.4.2', '1.4.1', '1.4.0',
    '1.3.2',
    '1.2.5', '1.2.4', '1.2.3',
    '1.1',
  ],
  neoforge: [
    '26.3', '26.2', '26.1.2', '26.1.1', '26.1',
    '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1',
  ],
};

export interface TemplatePreset {
  name: string;
  description: string;
  dockerImages: Record<string, string>;
  startupCommand: string;
  stopCommand: string;
  installImage: string;
  installEntrypoint: string;
  installScript: string;
  softwareKind: PresetKind;
  /** Full variable set, in the shape `createTemplate`/`seed.ts` already consume — defaults are all "latest"/free-text; `createFromPreset` is what narrows `versionVariable`'s (and `buildVariable`'s) `rules` to the admin's chosen `in:` list. */
  variables: TemplateVariableDto[];
  /** envVariable of the Minecraft-version field — every preset has exactly one. */
  versionVariable: string;
  /** envVariable of the build/loader-version field, or null when the software has no second tier (Vanilla). */
  buildVariable: string | null;
}

// Java is backward compatible (a newer JRE runs older bytecode fine), so
// one shared, reasonably current image covers every curated Minecraft
// version below it — the alternative (picking an image per version) has
// nowhere to live in this data model anyway (one dockerImages per
// TEMPLATE, not per version choice). Bump this whenever a new Minecraft
// release needs a newer classfile version than the current JRE here
// supports (java_21 = classfile 65; a real customer install of
// Minecraft 26.2 — classfile 69, i.e. Java 25 — failed outright with
// UnsupportedClassVersionError before this was bumped to java_25).
const JAVA_IMAGE = { 'Java 25': 'ghcr.io/pterodactyl/yolks:java_25' };
const STANDARD_STARTUP_COMMAND = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui';
const INSTALL_IMAGE = 'ghcr.io/parkervcp/installers:debian';
// Fabric/Quilt/Forge/NeoForge's own installers are Java programs
// (`java -jar *-installer.jar ...`), unlike Paper/Purpur/Vanilla which
// only ever `curl` a prebuilt jar — `INSTALL_IMAGE` (parkervcp/installers:
// debian) has curl/jq/bash but genuinely no JVM, so those scripts
// failed live with "install script exited 127" (command not found) on
// every real attempt. Same `parkervcp/installers` family, `java_25` tag
// instead — still has curl/jq/bash, plus a real OpenJDK.
const JAVA_INSTALL_IMAGE = 'ghcr.io/parkervcp/installers:java_25';
const INSTALL_ENTRYPOINT = 'bash';

// Every preset's last declared variable — the one thing the client-facing
// setup screen (ServerSetupService) and the admin wizard both agree is
// never player-editable: resources come from the purchased plan, never
// from a template default. See resolveDeclaredVariables's own doc comment.
function serverMemoryVariable(sortOrder: number): TemplateVariableDto {
  return {
    name: 'Server Memory (MB)',
    description: "The container's memory limit, substituted into -Xmx. Set by the plan, not directly editable.",
    envVariable: 'SERVER_MEMORY',
    defaultValue: '1024',
    rules: 'required|integer|min:512',
    isUserViewable: true,
    isUserEditable: false,
    sortOrder,
  };
}

function jarFileVariable(defaultValue: string): TemplateVariableDto {
  return {
    name: 'Server Jar File',
    description: 'The name of the server jar to execute.',
    envVariable: 'SERVER_JARFILE',
    defaultValue,
    rules: 'required|string|max:64',
    isUserViewable: true,
    isUserEditable: true,
    sortOrder: 0,
  };
}

function minecraftVersionVariable(description: string): TemplateVariableDto {
  return {
    name: 'Minecraft Version',
    description,
    envVariable: 'MINECRAFT_VERSION',
    defaultValue: 'latest',
    rules: 'required|string|max:16',
    isUserViewable: true,
    isUserEditable: true,
    sortOrder: 1,
  };
}

// Every install script ends by pinning `server-port` in server.properties
// to $SERVER_PORT (an agent-injected reserved env var — see the agent's
// buildEnvMap doc comment, routes_create_server.go): Docker publishes
// host port == container port, never NAT-remapped (game protocols embed
// the port in their own responses), so the game process itself MUST
// listen on that exact port. Minecraft only writes server.properties on
// its own first launch, defaulting server-port to 25565 — silently
// correct for whichever ONE allocation on a node happens to be 25565,
// and "connection refused" for every other one, since nothing else ever
// told it otherwise. Written before first launch, not after: the file
// may not exist yet (fresh install) or may already have a stale value
// from an earlier attempt (retry) — this handles both.
const PAPER_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${PAPER_BUILD:=latest}"
: "\${SERVER_JARFILE:=server.jar}"

if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(curl -sSL https://api.papermc.io/v2/projects/paper | jq -r '.versions[-1]')
fi

if [ "$PAPER_BUILD" == "latest" ]; then
  PAPER_BUILD=$(curl -sSL "https://api.papermc.io/v2/projects/paper/versions/\${MINECRAFT_VERSION}" | jq -r '.builds[-1]')
fi

DOWNLOAD_URL="https://api.papermc.io/v2/projects/paper/versions/\${MINECRAFT_VERSION}/builds/\${PAPER_BUILD}/downloads/paper-\${MINECRAFT_VERSION}-\${PAPER_BUILD}.jar"
echo "Downloading Paper \${MINECRAFT_VERSION} build \${PAPER_BUILD}..."
curl -sSL -o "\${SERVER_JARFILE}" "$DOWNLOAD_URL"

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

const FABRIC_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${FABRIC_LOADER_VERSION:=latest}"
: "\${SERVER_JARFILE:=fabric-server-launch.jar}"

if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(curl -sSL https://meta.fabricmc.net/v2/versions/game | jq -r '[.[] | select(.stable == true)][0].version')
fi
if [ "$FABRIC_LOADER_VERSION" == "latest" ]; then
  FABRIC_LOADER_VERSION=$(curl -sSL https://meta.fabricmc.net/v2/versions/loader | jq -r '[.[] | select(.stable == true)][0].version')
fi
INSTALLER_VERSION=$(curl -sSL https://meta.fabricmc.net/v2/versions/installer | jq -r '[.[] | select(.stable == true)][0].version')

echo "Downloading Fabric installer \${INSTALLER_VERSION}..."
curl -sSL -o fabric-installer.jar "https://maven.fabricmc.net/net/fabricmc/fabric-installer/\${INSTALLER_VERSION}/fabric-installer-\${INSTALLER_VERSION}.jar"
java -jar fabric-installer.jar server -mcversion "$MINECRAFT_VERSION" -loader "$FABRIC_LOADER_VERSION" -downloadMinecraft
rm -f fabric-installer.jar

if [ -f server.jar ] && [ "\${SERVER_JARFILE}" != "server.jar" ]; then
  mv server.jar "\${SERVER_JARFILE}"
fi

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

const QUILT_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${QUILT_LOADER_VERSION:=latest}"
: "\${SERVER_JARFILE:=quilt-server-launch.jar}"

if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(curl -sSL -A "gxhost-hosting-panel/0.1.0" https://meta.quiltmc.org/v3/versions/game | jq -r '[.[] | select(.stable == true)][0].version')
fi
if [ "$QUILT_LOADER_VERSION" == "latest" ]; then
  QUILT_LOADER_VERSION=$(curl -sSL -A "gxhost-hosting-panel/0.1.0" https://meta.quiltmc.org/v3/versions/loader | jq -r '[.[] | select(.version | test("-(alpha|beta|rc)"; "i") | not)][0].version')
fi
INSTALLER_URL=$(curl -sSL -A "gxhost-hosting-panel/0.1.0" https://meta.quiltmc.org/v3/versions/installer | jq -r '.[0].url')

echo "Downloading Quilt installer..."
curl -sSL -o quilt-installer.jar "$INSTALLER_URL"
java -jar quilt-installer.jar install server "$MINECRAFT_VERSION" "$QUILT_LOADER_VERSION" --download-server --install-dir=.
rm -f quilt-installer.jar

if [ -f quilt-server-launch.jar ] && [ "\${SERVER_JARFILE}" != "quilt-server-launch.jar" ]; then
  mv quilt-server-launch.jar "\${SERVER_JARFILE}"
fi

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

const VANILLA_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${SERVER_JARFILE:=server.jar}"

MANIFEST=$(curl -sSL https://launchermeta.mojang.com/mc/game/version_manifest.json)
if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(echo "$MANIFEST" | jq -r '.latest.release')
fi
VERSION_URL=$(echo "$MANIFEST" | jq -r --arg v "$MINECRAFT_VERSION" '.versions[] | select(.id == $v) | .url')
DOWNLOAD_URL=$(curl -sSL "$VERSION_URL" | jq -r '.downloads.server.url')

echo "Downloading vanilla Minecraft \${MINECRAFT_VERSION}..."
curl -sSL -o "\${SERVER_JARFILE}" "$DOWNLOAD_URL"

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

// Forge's promotions_slim.json maps "<mcVersion>-recommended"/"-latest" to
// a bare Forge version; the actual download path needs both joined as
// "<mcVersion>-<forgeVersion>". The installer's own output filename isn't
// fixed (varies by Forge version — a shim jar on newer versions, a
// universal jar on older ones), so this normalizes whichever one exists
// to SERVER_JARFILE afterward, same reasoning FABRIC_INSTALL_SCRIPT
// already uses for its own renamed jar.
const FORGE_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${FORGE_VERSION:=latest}"
: "\${SERVER_JARFILE:=server.jar}"

PROMOTIONS=$(curl -sSL https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json)

if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(echo "$PROMOTIONS" | jq -r '.promos | keys[]' | grep -E '^[0-9.]+-recommended$' | sed 's/-recommended$//' | sort -V | tail -n1)
fi

if [ "$FORGE_VERSION" == "latest" ]; then
  FORGE_VERSION=$(echo "$PROMOTIONS" | jq -r --arg v "$MINECRAFT_VERSION" '.promos[($v + "-recommended")] // .promos[($v + "-latest")]')
fi

FULL_VERSION="\${MINECRAFT_VERSION}-\${FORGE_VERSION}"
INSTALLER_URL="https://maven.minecraftforge.net/net/minecraftforge/forge/\${FULL_VERSION}/forge-\${FULL_VERSION}-installer.jar"
echo "Downloading Forge installer \${FULL_VERSION}..."
curl -sSL -o forge-installer.jar "$INSTALLER_URL"
java -jar forge-installer.jar --installServer
rm -f forge-installer.jar forge-installer.jar.log

FOUND_JAR=$(find . -maxdepth 1 \\( -name "forge-*-shim.jar" -o -name "forge-*-universal.jar" \\) | head -n1)
if [ -n "$FOUND_JAR" ] && [ "$FOUND_JAR" != "./\${SERVER_JARFILE}" ]; then
  mv "$FOUND_JAR" "\${SERVER_JARFILE}"
fi

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

// NeoForge's own version numbers already embed the Minecraft
// minor.patch they target (e.g. Minecraft 1.20.4 -> a "20.4.x" NeoForge
// release) — picking "latest for this Minecraft version" is filtering
// the release list by that prefix, no separate promotions endpoint
// needed the way Forge has one.
const NEOFORGE_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${NEOFORGE_VERSION:=latest}"
: "\${SERVER_JARFILE:=server.jar}"

VERSIONS=$(curl -sSL https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge | jq -r '.versions[]')

if [ "$NEOFORGE_VERSION" == "latest" ]; then
  if [ "$MINECRAFT_VERSION" == "latest" ]; then
    NEOFORGE_VERSION=$(echo "$VERSIONS" | sort -V | tail -n1)
  else
    # Only the old "1.x" Minecraft scheme drops a leading "1." to reach
    # NeoForge's own prefix (1.21.4 -> 21.4); the newer bare-year scheme
    # (26.1, 26.2, ...) already IS the NeoForge prefix as-is — stripping
    # its first segment too would turn "26.2" into "2" and never match.
    if [[ "$MINECRAFT_VERSION" == 1.* ]]; then
      PREFIX=$(echo "$MINECRAFT_VERSION" | cut -d. -f2-)
    else
      PREFIX="$MINECRAFT_VERSION"
    fi
    NEOFORGE_VERSION=$(echo "$VERSIONS" | grep "^\${PREFIX}\\." | sort -V | tail -n1)
  fi
fi

INSTALLER_URL="https://maven.neoforged.net/releases/net/neoforged/neoforge/\${NEOFORGE_VERSION}/neoforge-\${NEOFORGE_VERSION}-installer.jar"
echo "Downloading NeoForge installer \${NEOFORGE_VERSION}..."
curl -sSL -o neoforge-installer.jar "$INSTALLER_URL"
java -jar neoforge-installer.jar --installServer
rm -f neoforge-installer.jar neoforge-installer.jar.log

FOUND_JAR=$(find . -maxdepth 1 \\( -name "*-shim.jar" -o -name "*-universal.jar" \\) | head -n1)
if [ -n "$FOUND_JAR" ] && [ "$FOUND_JAR" != "./\${SERVER_JARFILE}" ]; then
  mv "$FOUND_JAR" "\${SERVER_JARFILE}"
fi

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

// PurpurMC mirrors PaperMC's own REST API shape almost exactly (same
// "/v2/<project>" versions list, "/v2/<project>/<version>" build list) —
// this script is PAPER_INSTALL_SCRIPT's structure with the project name
// and the (slightly different) build-number field swapped.
const PURPUR_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
cd /mnt/server

: "\${MINECRAFT_VERSION:=latest}"
: "\${PURPUR_BUILD:=latest}"
: "\${SERVER_JARFILE:=server.jar}"

if [ "$MINECRAFT_VERSION" == "latest" ]; then
  MINECRAFT_VERSION=$(curl -sSL https://api.purpurmc.org/v2/purpur | jq -r '.versions[-1]')
fi

if [ "$PURPUR_BUILD" == "latest" ]; then
  PURPUR_BUILD=$(curl -sSL "https://api.purpurmc.org/v2/purpur/\${MINECRAFT_VERSION}" | jq -r '.builds.latest')
fi

DOWNLOAD_URL="https://api.purpurmc.org/v2/purpur/\${MINECRAFT_VERSION}/\${PURPUR_BUILD}/download"
echo "Downloading Purpur \${MINECRAFT_VERSION} build \${PURPUR_BUILD}..."
curl -sSL -o "\${SERVER_JARFILE}" "$DOWNLOAD_URL"

echo "eula=true" > eula.txt
if grep -q '^server-port=' server.properties 2>/dev/null; then
  sed -i "s/^server-port=.*/server-port=\${SERVER_PORT}/" server.properties
else
  echo "server-port=\${SERVER_PORT}" >> server.properties
fi
echo "Install complete."
`;

export const SOFTWARE_PRESETS: Record<PresetKind, TemplatePreset> = {
  paper: {
    name: 'Paper',
    description: 'Servidor Paper de alto desempenho para Minecraft: Java Edition.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: PAPER_INSTALL_SCRIPT,
    softwareKind: 'paper',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'PAPER_BUILD',
    variables: [
      jarFileVariable('server.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      {
        name: 'Paper Build',
        description: 'The Paper build number to install. Use "latest" for the newest build.',
        envVariable: 'PAPER_BUILD',
        defaultValue: 'latest',
        rules: 'required|string|max:16',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
  fabric: {
    name: 'Fabric',
    description: 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Fabric.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: JAVA_INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: FABRIC_INSTALL_SCRIPT,
    softwareKind: 'fabric',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'FABRIC_LOADER_VERSION',
    variables: [
      jarFileVariable('fabric-server-launch.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      {
        name: 'Fabric Loader Version',
        description: 'The Fabric loader version to install. Use "latest" for the newest stable release.',
        envVariable: 'FABRIC_LOADER_VERSION',
        defaultValue: 'latest',
        rules: 'required|string|max:16',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
  quilt: {
    name: 'Quilt',
    description: 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Quilt.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: JAVA_INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: QUILT_INSTALL_SCRIPT,
    softwareKind: 'quilt',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'QUILT_LOADER_VERSION',
    variables: [
      jarFileVariable('quilt-server-launch.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      {
        name: 'Quilt Loader Version',
        description: 'The Quilt loader version to install. Use "latest" for the newest stable release.',
        envVariable: 'QUILT_LOADER_VERSION',
        defaultValue: 'latest',
        rules: 'required|string|max:32',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
  vanilla: {
    name: 'Vanilla',
    description: 'Servidor oficial e sem modificações do Minecraft: Java Edition — sem plugins ou mods.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: VANILLA_INSTALL_SCRIPT,
    softwareKind: 'vanilla',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: null,
    variables: [
      jarFileVariable('server.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      serverMemoryVariable(2),
    ],
  },
  forge: {
    name: 'Forge',
    description: 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Forge.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: JAVA_INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: FORGE_INSTALL_SCRIPT,
    softwareKind: 'forge',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'FORGE_VERSION',
    variables: [
      jarFileVariable('server.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release Forge publishes a recommended build for.'),
      {
        name: 'Forge Version',
        description: 'The Forge version to install. Use "latest" for the recommended build matching the Minecraft version above.',
        envVariable: 'FORGE_VERSION',
        defaultValue: 'latest',
        rules: 'required|string|max:32',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
  neoforge: {
    name: 'NeoForge',
    description: 'Servidor modificado de Minecraft: Java Edition com NeoForge, fork do Forge mantido ativamente para versões modernas.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: JAVA_INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: NEOFORGE_INSTALL_SCRIPT,
    softwareKind: 'neoforge',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'NEOFORGE_VERSION',
    variables: [
      jarFileVariable('server.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      {
        name: 'NeoForge Version',
        description: 'The NeoForge version to install. Use "latest" for the newest build matching the Minecraft version above.',
        envVariable: 'NEOFORGE_VERSION',
        defaultValue: 'latest',
        rules: 'required|string|max:32',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
  purpur: {
    name: 'Purpur',
    description: 'Servidor baseado no Paper com ajustes extras de desempenho e jogabilidade — compatível com plugins do Paper.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
    installEntrypoint: INSTALL_ENTRYPOINT,
    installScript: PURPUR_INSTALL_SCRIPT,
    softwareKind: 'purpur',
    versionVariable: 'MINECRAFT_VERSION',
    buildVariable: 'PURPUR_BUILD',
    variables: [
      jarFileVariable('server.jar'),
      minecraftVersionVariable('The version of Minecraft to install. Use "latest" for the newest release.'),
      {
        name: 'Purpur Build',
        description: 'The Purpur build number to install. Use "latest" for the newest build.',
        envVariable: 'PURPUR_BUILD',
        defaultValue: 'latest',
        rules: 'required|string|max:16',
        isUserViewable: true,
        isUserEditable: true,
        sortOrder: 2,
      },
      serverMemoryVariable(3),
    ],
  },
};
