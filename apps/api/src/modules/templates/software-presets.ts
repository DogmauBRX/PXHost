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
export const PRESET_KINDS = ['paper', 'fabric', 'vanilla', 'forge', 'neoforge', 'purpur'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

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
echo "Install complete."
`;

export const SOFTWARE_PRESETS: Record<PresetKind, TemplatePreset> = {
  paper: {
    name: 'Paper',
    description: 'High-performance Paper server for Minecraft: Java Edition.',
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
    description: 'Modded Minecraft: Java Edition server running the Fabric mod loader.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
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
  vanilla: {
    name: 'Vanilla',
    description: 'Unmodified, official Minecraft: Java Edition server — no plugins or mods.',
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
    description: 'Modded Minecraft: Java Edition server running the Forge mod loader.',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
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
    description: 'Modded Minecraft: Java Edition server running the NeoForge mod loader (the actively-maintained fork of Forge for modern versions).',
    dockerImages: JAVA_IMAGE,
    startupCommand: STANDARD_STARTUP_COMMAND,
    stopCommand: 'stop',
    installImage: INSTALL_IMAGE,
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
    description: 'Paper-based server with extra performance tuning and gameplay options — drop-in compatible with Paper plugins.',
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
