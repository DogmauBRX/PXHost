// Seeds the root admin account (milestone M3 DoD: "seed root admin").
// Runs against DIRECT_DATABASE_URL implicitly via PrismaClient's default
// datasource resolution when invoked through `prisma db seed` /
// `pnpm prisma:seed` — idempotent, safe to re-run.
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_ROOT_ADMIN_EMAIL ?? 'admin@pxhost.local';
  const password = process.env.SEED_ROOT_ADMIN_PASSWORD ?? 'ChangeMe!23456';

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 2,
    hashLength: 32,
  });

  // email isn't a Prisma-level @unique field (uniqueness is enforced via a
  // soft-delete-aware PARTIAL index created in raw SQL — see migration
  // 0001_init — which Prisma's schema DSL can't express as `@unique`), so
  // `upsert` isn't available here; find-then-create/update by hand instead.
  const existing = await prisma.user.findFirst({ where: { email } });
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: {} })
    : await prisma.user.create({
        data: {
          email,
          username: 'admin',
          passwordHash,
          globalRole: 'root_admin',
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      });

  // eslint-disable-next-line no-console
  console.log(`Seeded root admin: ${user.email} (id=${user.id})`);
  if (!process.env.SEED_ROOT_ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.log(`  Default password: ${password} — change this immediately in any shared environment.`);
  }

  await seedLocationAndTemplate();
  await seedPermissionCatalog();
  await seedPlans();
}

// architecture doc 2.5's permission groups, scoped to what the panel
// actually enforces (allocation.*/settings.* still aren't listed — nothing
// lets a customer touch those yet, so seeding keys for them would just be
// dead data with no code path checking them). startup.* was in that same
// dead-data category until the Configurações tab (client-features Fase 7)
// gave it a real code path — server-variables.service.ts.
// "permission_catalog is data, not code" (doc 2.1) — adding a key here
// is the only change needed to make a new permission exist; no migration.
const PERMISSION_CATALOG: { key: string; groupKey: string; i18nKey: string; isDangerous?: boolean; sortOrder: number }[] = [
  { key: 'websocket.connect', groupKey: 'control', i18nKey: 'permission.websocket.connect', sortOrder: 0 },
  { key: 'control.console', groupKey: 'control', i18nKey: 'permission.control.console', sortOrder: 1 },
  { key: 'control.start', groupKey: 'control', i18nKey: 'permission.control.start', sortOrder: 2 },
  { key: 'control.stop', groupKey: 'control', i18nKey: 'permission.control.stop', sortOrder: 3 },
  { key: 'control.restart', groupKey: 'control', i18nKey: 'permission.control.restart', sortOrder: 4 },
  { key: 'control.kill', groupKey: 'control', i18nKey: 'permission.control.kill', isDangerous: true, sortOrder: 5 },
  // Read-only usage snapshot (client-features roadmap) — a `.read` key, so
  // allowedWhenSuspended() passes it unconditionally: a suspended customer
  // can still see WHY they're suspended (e.g. memory pressure) instead of
  // just a dead console.
  { key: 'server.read', groupKey: 'server', i18nKey: 'permission.server.read', sortOrder: 6 },

  // Startup variables (client-features Fase 7). `.update` requires the
  // server to be stopped (enforced in server-variables.service.ts, not
  // here) — a permission key doesn't encode WHEN an action is allowed,
  // only WHO can attempt it.
  { key: 'startup.read', groupKey: 'startup', i18nKey: 'permission.startup.read', sortOrder: 7 },
  { key: 'startup.update', groupKey: 'startup', i18nKey: 'permission.startup.update', isDangerous: true, sortOrder: 8 },

  { key: 'file.read', groupKey: 'file', i18nKey: 'permission.file.read', sortOrder: 10 },
  { key: 'file.write', groupKey: 'file', i18nKey: 'permission.file.write', sortOrder: 11 },
  { key: 'file.delete', groupKey: 'file', i18nKey: 'permission.file.delete', isDangerous: true, sortOrder: 12 },

  { key: 'backup.read', groupKey: 'backup', i18nKey: 'permission.backup.read', sortOrder: 20 },
  { key: 'backup.create', groupKey: 'backup', i18nKey: 'permission.backup.create', sortOrder: 21 },
  { key: 'backup.delete', groupKey: 'backup', i18nKey: 'permission.backup.delete', isDangerous: true, sortOrder: 22 },
  { key: 'backup.restore', groupKey: 'backup', i18nKey: 'permission.backup.restore', isDangerous: true, sortOrder: 23 },

  { key: 'database.read', groupKey: 'database', i18nKey: 'permission.database.read', sortOrder: 30 },
  { key: 'database.create', groupKey: 'database', i18nKey: 'permission.database.create', sortOrder: 31 },
  { key: 'database.delete', groupKey: 'database', i18nKey: 'permission.database.delete', isDangerous: true, sortOrder: 32 },

  { key: 'schedule.read', groupKey: 'schedule', i18nKey: 'permission.schedule.read', sortOrder: 40 },
  { key: 'schedule.create', groupKey: 'schedule', i18nKey: 'permission.schedule.create', sortOrder: 41 },
  { key: 'schedule.update', groupKey: 'schedule', i18nKey: 'permission.schedule.update', sortOrder: 42 },
  { key: 'schedule.delete', groupKey: 'schedule', i18nKey: 'permission.schedule.delete', isDangerous: true, sortOrder: 43 },

  { key: 'user.read', groupKey: 'user', i18nKey: 'permission.user.read', sortOrder: 50 },
  { key: 'user.create', groupKey: 'user', i18nKey: 'permission.user.create', isDangerous: true, sortOrder: 51 },
  { key: 'user.update', groupKey: 'user', i18nKey: 'permission.user.update', isDangerous: true, sortOrder: 52 },
  { key: 'user.delete', groupKey: 'user', i18nKey: 'permission.user.delete', isDangerous: true, sortOrder: 53 },

  { key: 'activity.read', groupKey: 'activity', i18nKey: 'permission.activity.read', sortOrder: 60 },
];

async function seedPermissionCatalog(): Promise<void> {
  for (const entry of PERMISSION_CATALOG) {
    await prisma.permissionCatalog.upsert({
      where: { key: entry.key },
      update: { groupKey: entry.groupKey, i18nKey: entry.i18nKey, isDangerous: entry.isDangerous ?? false, sortOrder: entry.sortOrder },
      create: { key: entry.key, scope: 'server', groupKey: entry.groupKey, i18nKey: entry.i18nKey, isDangerous: entry.isDangerous ?? false, sortOrder: entry.sortOrder },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded permission_catalog: ${PERMISSION_CATALOG.length} keys`);
}

// Milestone M4 DoD: "Minecraft template with install script stored and
// renderable." dockerImages/startupCommand/variables here are exactly the
// shape internal/config.LoadServer on the Go agent consumes — startupCommand
// goes through spec.BuildArgv's tokenize-then-substitute, and each
// declared variable's envVariable must match the agent's own
// `^[A-Z][A-Z0-9_]{0,63}$` allowlist regex (see TemplatesService's
// validateDeclaredVariables, which enforces the same rule for anything
// created through the API from here on).
async function seedLocationAndTemplate(): Promise<void> {
  const location = await findOrCreate(
    () => prisma.location.findFirst({ where: { shortCode: 'local' } }),
    () => prisma.location.create({ data: { shortCode: 'local', name: 'Local Development' } }),
  );

  const group = await findOrCreate(
    () => prisma.templateGroup.findFirst({ where: { name: 'Minecraft' } }),
    () => prisma.templateGroup.create({ data: { name: 'Minecraft', description: 'Minecraft: Java Edition servers' } }),
  );

  const existingTemplate = await prisma.serverTemplate.findFirst({ where: { groupId: group.id, name: 'Paper' } });
  if (!existingTemplate) {
    await prisma.serverTemplate.create({
      data: {
        groupId: group.id,
        name: 'Paper',
        author: 'pxhost',
        description: 'High-performance Paper server for Minecraft: Java Edition.',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        stopCommand: 'stop',
        installImage: 'ghcr.io/pxhost/installers:debian',
        installEntrypoint: 'bash',
        installScript: PAPER_INSTALL_SCRIPT,
        features: ['eula', 'java_version'],
        // Explicit here, not left to migration 0008's ILIKE backfill — that
        // backfill only ever runs once, against rows that already existed
        // at migration time. A template created by THIS seed script on a
        // brand-new database never goes through it.
        softwareKind: 'paper',
        variables: {
          create: [
            {
              name: 'Server Jar File',
              description: 'The name of the server jar to execute.',
              envVariable: 'SERVER_JARFILE',
              defaultValue: 'server.jar',
              rules: 'required|string|max:64',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
            {
              name: 'Minecraft Version',
              description: 'The version of Minecraft to install. Use "latest" for the newest release.',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'latest',
              rules: 'required|string|max:16',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 1,
            },
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
            {
              name: 'Server Memory (MB)',
              description: "The container's memory limit, substituted into -Xmx. Set by the plan, not directly editable.",
              envVariable: 'SERVER_MEMORY',
              defaultValue: '1024',
              rules: 'required|integer|min:512',
              isUserViewable: true,
              isUserEditable: false,
              sortOrder: 3,
            },
          ],
        },
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded template group "${group.name}" and template "Paper" in location "${location.name}"`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Template "Paper" already present — skipped`);
  }

  // Fabric (mods) and Vanilla (no add-ons) alongside Paper (plugins) so
  // the software-mismatch and "no add-ons" code paths — the Add-ons tab
  // hiding itself, the assistant's addons.unsupported topic — are
  // actually reachable in a fresh install instead of only provable by
  // hand-editing a template's software_kind after the fact.
  const existingFabric = await prisma.serverTemplate.findFirst({ where: { groupId: group.id, name: 'Fabric' } });
  if (!existingFabric) {
    await prisma.serverTemplate.create({
      data: {
        groupId: group.id,
        name: 'Fabric',
        author: 'pxhost',
        description: 'Modded Minecraft: Java Edition server running the Fabric mod loader.',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        stopCommand: 'stop',
        installImage: 'ghcr.io/pxhost/installers:debian',
        installEntrypoint: 'bash',
        installScript: FABRIC_INSTALL_SCRIPT,
        features: ['eula', 'java_version'],
        softwareKind: 'fabric',
        variables: {
          create: [
            {
              name: 'Server Jar File',
              description: 'The name of the server jar to execute.',
              envVariable: 'SERVER_JARFILE',
              defaultValue: 'fabric-server-launch.jar',
              rules: 'required|string|max:64',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
            {
              name: 'Minecraft Version',
              description: 'The version of Minecraft to install. Use "latest" for the newest release.',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'latest',
              rules: 'required|string|max:16',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 1,
            },
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
            {
              name: 'Server Memory (MB)',
              description: "The container's memory limit, substituted into -Xmx. Set by the plan, not directly editable.",
              envVariable: 'SERVER_MEMORY',
              defaultValue: '1024',
              rules: 'required|integer|min:512',
              isUserViewable: true,
              isUserEditable: false,
              sortOrder: 3,
            },
          ],
        },
      },
    });
    // eslint-disable-next-line no-console
    console.log('Seeded template "Fabric"');
  } else {
    // eslint-disable-next-line no-console
    console.log('Template "Fabric" already present — skipped');
  }

  const existingVanilla = await prisma.serverTemplate.findFirst({ where: { groupId: group.id, name: 'Vanilla' } });
  if (!existingVanilla) {
    await prisma.serverTemplate.create({
      data: {
        groupId: group.id,
        name: 'Vanilla',
        author: 'pxhost',
        description: 'Unmodified, official Minecraft: Java Edition server — no plugins or mods.',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        stopCommand: 'stop',
        installImage: 'ghcr.io/pxhost/installers:debian',
        installEntrypoint: 'bash',
        installScript: VANILLA_INSTALL_SCRIPT,
        features: ['eula', 'java_version'],
        softwareKind: 'vanilla',
        variables: {
          create: [
            {
              name: 'Server Jar File',
              description: 'The name of the server jar to execute.',
              envVariable: 'SERVER_JARFILE',
              defaultValue: 'server.jar',
              rules: 'required|string|max:64',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 0,
            },
            {
              name: 'Minecraft Version',
              description: 'The version of Minecraft to install. Use "latest" for the newest release.',
              envVariable: 'MINECRAFT_VERSION',
              defaultValue: 'latest',
              rules: 'required|string|max:16',
              isUserViewable: true,
              isUserEditable: true,
              sortOrder: 1,
            },
            {
              name: 'Server Memory (MB)',
              description: "The container's memory limit, substituted into -Xmx. Set by the plan, not directly editable.",
              envVariable: 'SERVER_MEMORY',
              defaultValue: '1024',
              rules: 'required|integer|min:512',
              isUserViewable: true,
              isUserEditable: false,
              sortOrder: 2,
            },
          ],
        },
      },
    });
    // eslint-disable-next-line no-console
    console.log('Seeded template "Vanilla"');
  } else {
    // eslint-disable-next-line no-console
    console.log('Template "Vanilla" already present — skipped');
  }
}

interface PlanSeed {
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  maxDatabases: number;
  maxBackups: number;
  maxAllocations: number;
  maxSchedules: number;
  backupRetentionDays: number;
  priceCents: number;
  maxServers: number;
  recommendedPlayersMin: number;
  recommendedPlayersMax: number | null;
  recommendedModsMin: number | null;
  recommendedModsMax: number | null;
  recommendedPluginsMin: number | null;
  recommendedPluginsMax: number | null;
}

// Prices are placeholders (R$ 19,90 / 49,90 / 99,90) — adjustable on the
// admin Plans screen (client-features Fase 2) without touching code.
// Recommendation ranges are the ones from the client-features request
// itself: 5-10 / 15-30 / 40-60 players, 10-30 / 30-80 / 80+ mods or
// plugins (mods and plugins share the same recommended count — the
// distinction is which directory they land in, not how many are
// reasonable).
const PLAN_SEEDS: PlanSeed[] = [
  {
    name: 'Básico',
    slug: 'basico',
    description: 'Ideal para grupos pequenos de amigos.',
    sortOrder: 0,
    memoryMb: 2048,
    diskMb: 5120,
    cpuLimitPercent: 100,
    maxDatabases: 1,
    maxBackups: 3,
    maxAllocations: 1,
    maxSchedules: 3,
    backupRetentionDays: 7,
    priceCents: 1990,
    maxServers: 1,
    recommendedPlayersMin: 5,
    recommendedPlayersMax: 10,
    recommendedModsMin: 10,
    recommendedModsMax: 30,
    recommendedPluginsMin: 10,
    recommendedPluginsMax: 30,
  },
  {
    name: 'Intermediário',
    slug: 'medio',
    description: 'Para comunidades em crescimento, com mais mods e plugins.',
    sortOrder: 1,
    memoryMb: 6144,
    diskMb: 15360,
    cpuLimitPercent: 200,
    maxDatabases: 2,
    maxBackups: 5,
    maxAllocations: 2,
    maxSchedules: 5,
    backupRetentionDays: 14,
    priceCents: 4990,
    maxServers: 2,
    recommendedPlayersMin: 15,
    recommendedPlayersMax: 30,
    recommendedModsMin: 30,
    recommendedModsMax: 80,
    recommendedPluginsMin: 30,
    recommendedPluginsMax: 80,
  },
  {
    name: 'Avançado',
    slug: 'avancado',
    description: 'Para servidores grandes, com muitos jogadores e mods pesados.',
    sortOrder: 2,
    memoryMb: 12288,
    diskMb: 30720,
    cpuLimitPercent: 400,
    maxDatabases: 4,
    maxBackups: 10,
    maxAllocations: 3,
    maxSchedules: 10,
    backupRetentionDays: 30,
    priceCents: 9990,
    maxServers: 3,
    recommendedPlayersMin: 40,
    recommendedPlayersMax: 60,
    recommendedModsMin: 80,
    recommendedModsMax: null,
    recommendedPluginsMin: 80,
    recommendedPluginsMax: null,
  },
];

// `slug` has no @unique constraint Prisma can `upsert` against (see the
// root-admin seed's own note on the same limitation for `email`) — find
// by slug, then create-if-missing. Deliberately skip-not-update on a
// second run: an admin may have already edited a seeded plan's price or
// recommendations through the Fase 2 UI, and a re-seed silently
// clobbering that would be a worse surprise than a plan just not existing
// yet.
async function seedPlans(): Promise<void> {
  for (const p of PLAN_SEEDS) {
    const existing = await prisma.plan.findFirst({ where: { slug: p.slug, deletedAt: null } });
    if (existing) {
      // eslint-disable-next-line no-console
      console.log(`Plan "${p.name}" already present — skipped`);
      continue;
    }
    await prisma.plan.create({
      data: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        isPublic: true,
        sortOrder: p.sortOrder,
        cpuLimitPercent: p.cpuLimitPercent,
        memoryMb: p.memoryMb,
        diskMb: p.diskMb,
        maxDatabases: p.maxDatabases,
        maxBackups: p.maxBackups,
        maxAllocations: p.maxAllocations,
        maxSchedules: p.maxSchedules,
        backupRetentionDays: p.backupRetentionDays,
        priceCents: p.priceCents,
        currency: 'BRL',
        billingPeriod: 'monthly',
        maxServers: p.maxServers,
        recommendedPlayersMin: p.recommendedPlayersMin,
        recommendedPlayersMax: p.recommendedPlayersMax,
        recommendedModsMin: p.recommendedModsMin,
        recommendedModsMax: p.recommendedModsMax,
        recommendedPluginsMin: p.recommendedPluginsMin,
        recommendedPluginsMax: p.recommendedPluginsMax,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded plan "${p.name}"`);
  }
}

async function findOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  return existing ?? create();
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

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
