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
}

// architecture doc 2.5's permission groups, scoped to what M11 actually
// enforces (allocation.*/startup.*/settings.* aren't listed — nothing in
// the panel lets a customer touch those yet, so seeding permission keys
// for them would just be dead data with no code path checking them).
// "permission_catalog is data, not code" (doc 2.1) — adding a key here
// is the only change needed to make a new permission exist; no migration.
const PERMISSION_CATALOG: { key: string; groupKey: string; i18nKey: string; isDangerous?: boolean; sortOrder: number }[] = [
  { key: 'websocket.connect', groupKey: 'control', i18nKey: 'permission.websocket.connect', sortOrder: 0 },
  { key: 'control.console', groupKey: 'control', i18nKey: 'permission.control.console', sortOrder: 1 },
  { key: 'control.start', groupKey: 'control', i18nKey: 'permission.control.start', sortOrder: 2 },
  { key: 'control.stop', groupKey: 'control', i18nKey: 'permission.control.stop', sortOrder: 3 },
  { key: 'control.restart', groupKey: 'control', i18nKey: 'permission.control.restart', sortOrder: 4 },
  { key: 'control.kill', groupKey: 'control', i18nKey: 'permission.control.kill', isDangerous: true, sortOrder: 5 },

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

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
